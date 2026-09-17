import { describe, expect, it, vi } from 'vitest';

import { TizenAvplayAdapter } from '../src/tizen-avplay';
import type { AvplayListener, AvplayTrackInfo } from '../src/tizen-avplay';
import { VizioHtml5Adapter } from '../src/vizio-html5';

class FakeAvplay {
  listener: AvplayListener = {};
  tracks: AvplayTrackInfo[] = [
    { index: 1, type: 'AUDIO', extra_info: '{"language":"eng"}' },
    { index: 2, type: 'TEXT', extra_info: '{"language":"spa"}' },
  ];
  prepareSuccess?: () => void;
  closed = 0;
  selected: Array<[string, number]> = [];
  open = vi.fn();
  close = vi.fn(() => { this.closed += 1; });
  play = vi.fn();
  pause = vi.fn();
  stop = vi.fn();
  getCurrentTime = vi.fn(() => 12_000);
  getDuration = vi.fn(() => 120_000);
  setListener = vi.fn((listener: AvplayListener) => { this.listener = listener; });
  prepareAsync = vi.fn((success: () => void) => { this.prepareSuccess = success; });
  seekTo = vi.fn((_: number, success?: () => void) => { success?.(); });
  getTotalTrackInfo = vi.fn(() => this.tracks);
  setSelectTrack = vi.fn((kind: string, index: number) => { this.selected.push([kind, index]); });
  setSilentSubtitle = vi.fn();
  setStreamingProperty = vi.fn();
  setDisplayRect = vi.fn();
}

class FakeMedia {
  src = '';
  currentTime = 0;
  duration = 100;
  paused = true;
  ended = false;
  error: { code: number; message?: string } | null = null;
  textTracks: Array<{ kind: string; label: string; language: string; mode: 'disabled' | 'hidden' | 'showing' }> = [
    { kind: 'subtitles', label: 'Spanish', language: 'es', mode: 'disabled' },
  ];
  private listeners = new Map<string, Set<() => void>>();
  play = vi.fn(async () => { this.paused = false; this.emit('play'); });
  pause = vi.fn(() => { this.paused = true; this.emit('pause'); });
  load = vi.fn();
  addEventListener(type: string, callback: () => void) {
    const callbacks = this.listeners.get(type) ?? new Set();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }
  removeEventListener(type: string, callback: () => void) { this.listeners.get(type)?.delete(callback); }
  emit(type: string) { this.listeners.get(type)?.forEach((callback) => callback()); }
  listenerCount(type: string) { return this.listeners.get(type)?.size ?? 0; }
}

describe('TizenAvplayAdapter', () => {
  it('opens the exact selected source, exposes tracks, and ignores a stale preparation callback', async () => {
    const avplay = new FakeAvplay();
    const player = new TizenAvplayAdapter(avplay);
    const snapshots: string[] = [];
    player.subscribe((snapshot) => snapshots.push(`${snapshot.sessionId}:${snapshot.state}`));

    const first = player.open({ url: 'https://media.example/first.mp4', kind: 'vod' });
    const firstSuccess = avplay.prepareSuccess!;
    const second = player.open({ url: 'https://media.example/second.mp4', kind: 'vod', startAtSeconds: 30, paused: true });
    firstSuccess();
    avplay.prepareSuccess!();
    await Promise.all([first, second]);

    expect(avplay.open).toHaveBeenNthCalledWith(1, 'https://media.example/first.mp4');
    expect(avplay.open).toHaveBeenNthCalledWith(2, 'https://media.example/second.mp4');
    expect(player.snapshot.state).toBe('paused');
    expect(player.snapshot.time.positionSeconds).toBe(30);
    expect(player.snapshot.tracks.audio).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'audio:1', language: 'eng' })]));
    expect(player.snapshot.tracks.text).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'text:2', language: 'spa' })]));
    expect(snapshots).not.toContain('1:ready');
  });

  it('maps AVPlay callbacks to state and suppresses callbacks after stop', async () => {
    const avplay = new FakeAvplay();
    const player = new TizenAvplayAdapter(avplay);
    const opening = player.open({ url: 'https://media.example/show.m3u8', kind: 'vod' });
    avplay.prepareSuccess!();
    await opening;

    avplay.listener.onbufferingstart?.();
    expect(player.snapshot.state).toBe('buffering');
    avplay.listener.oncurrentplaytime?.(45_000);
    expect(player.snapshot.time.positionSeconds).toBe(45);
    await player.stop();
    avplay.listener.onerror?.('PLAYER_ERROR_CONNECTION_FAILED');
    expect(player.snapshot.state).toBe('stopped');
  });

  it('sets AVPlay authorization only after open enters the documented IDLE state', async () => {
    const avplay = new FakeAvplay();
    const player = new TizenAvplayAdapter(avplay);
    const opening = player.open({
      url: 'https://media.example/protected.m3u8',
      kind: 'vod',
      authorization: { cookie: 'session=signed', userAgent: 'VIPTV/1' },
    });

    expect(avplay.open.mock.invocationCallOrder[0]).toBeLessThan(avplay.setStreamingProperty.mock.invocationCallOrder[0]);
    expect(avplay.setStreamingProperty).toHaveBeenCalledWith('COOKIE', 'session=signed');
    expect(avplay.setStreamingProperty).toHaveBeenCalledWith('USER_AGENT', 'VIPTV/1');
    avplay.prepareSuccess!();
    await opening;
  });

  it('sets a full viewport display rect before AVPlay prepares the stream', async () => {
    const avplay = new FakeAvplay();
    const player = new TizenAvplayAdapter(avplay);
    const opening = player.open({ url: 'https://media.example/display.mp4', kind: 'vod' });

    expect(avplay.setDisplayRect).toHaveBeenCalledWith(0, 0, window.innerWidth, window.innerHeight);
    expect(avplay.setDisplayRect.mock.invocationCallOrder[0]).toBeLessThan(avplay.prepareAsync.mock.invocationCallOrder[0]);
    avplay.prepareSuccess!();
    await opening;
  });

  it('selects tracks only when AVPlay reported them and reports unsupported requests truthfully', async () => {
    const avplay = new FakeAvplay();
    const player = new TizenAvplayAdapter(avplay);
    const opening = player.open({ url: 'https://media.example/show.mp4', kind: 'vod' });
    avplay.prepareSuccess!();
    await opening;

    await player.selectAudioTrack('audio:1');
    await player.selectTextTrack('text:2');
    expect(avplay.selected).toEqual([['AUDIO', 1], ['TEXT', 2]]);
    expect(avplay.setSilentSubtitle).toHaveBeenLastCalledWith(false);
    await player.selectTextTrack(null);
    expect(avplay.setSilentSubtitle).toHaveBeenLastCalledWith(true);
    await expect(player.selectAudioTrack('audio:404')).rejects.toMatchObject({ code: 'unsupported-operation' });
  });

  it('keeps managed title time absolute when AVPlay cannot read the native clock after seek', async () => {
    const avplay = new FakeAvplay();
    const player = new TizenAvplayAdapter(avplay);
    const opening = player.open({ url: 'https://media.example/managed.mp4', kind: 'vod', timelineOffsetSeconds: 25 });
    avplay.prepareSuccess!();
    await opening;

    avplay.getCurrentTime.mockImplementation(() => { throw new Error('clock unavailable'); });
    await player.seek(55);

    expect(player.snapshot.time.positionSeconds).toBe(55);
  });
});

describe('VizioHtml5Adapter', () => {
  it('uses a backend-compatible URL directly, tracks media state, and supports text tracks', async () => {
    const media = new FakeMedia();
    const player = new VizioHtml5Adapter(media);
    const opening = player.open({ url: 'https://backend.example/direct.mp4', kind: 'vod', startAtSeconds: 12 });
    media.emit('loadedmetadata');
    await opening;

    expect(media.src).toBe('https://backend.example/direct.mp4');
    expect(player.snapshot.time.positionSeconds).toBe(12);
    await player.play();
    expect(player.snapshot.state).toBe('playing');
    await player.selectTextTrack('text:0');
    expect(media.textTracks[0].mode).toBe('showing');
    await player.selectTextTrack(null);
    expect(media.textTracks[0].mode).toBe('disabled');
  });

  it('does not claim custom-header or audio-track support and rejects a request requiring them', async () => {
    const media = new FakeMedia();
    const player = new VizioHtml5Adapter(media);

    await expect(player.open({
      url: 'https://backend.example/direct.mp4',
      kind: 'vod',
      authorization: { cookie: 'session=private' },
    })).rejects.toMatchObject({ code: 'unsupported-operation' });
    expect(player.capabilities.canUseCookies).toBe(false);
    await expect(player.selectAudioTrack('audio:0')).rejects.toMatchObject({ code: 'unsupported-operation' });
  });

  it('cancels an old open before a new selected source can publish readiness', async () => {
    const media = new FakeMedia();
    const player = new VizioHtml5Adapter(media);
    const first = player.open({ url: 'https://backend.example/first.mp4', kind: 'vod' });
    const second = player.open({ url: 'https://backend.example/second.mp4', kind: 'vod', paused: true });
    media.emit('loadedmetadata');
    await Promise.all([first, second]);

    expect(player.snapshot.sessionId).toBe(2);
    expect(player.snapshot.state).toBe('paused');
    expect(media.listenerCount('loadedmetadata')).toBe(1);
  });

  it('preserves native text-track indices when non-subtitle tracks precede captions', async () => {
    const media = new FakeMedia();
    media.textTracks.unshift({ kind: 'metadata', label: 'Markers', language: '', mode: 'disabled' });
    const player = new VizioHtml5Adapter(media);
    const opening = player.open({ url: 'https://backend.example/direct.mp4', kind: 'vod' });
    media.emit('loadedmetadata');
    await opening;

    expect(player.snapshot.tracks.text).toEqual([expect.objectContaining({ id: 'text:1', label: 'Spanish' })]);
    await player.selectTextTrack('text:1');
    expect(media.textTracks[1].mode).toBe('showing');
  });
});
