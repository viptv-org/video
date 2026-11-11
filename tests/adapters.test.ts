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
  buffered: { length: number; start(index: number): number; end(index: number): number } | null = null;
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

it('keeps a native metadata seek and delayed playing events paused until Play is requested', async () => {
  const media = new FakeMedia();
  let currentTime = 0;
  Object.defineProperty(media, 'canPlayType', { value: () => 'probably' });
  Object.defineProperty(media, 'currentTime', {
    get: () => currentTime,
    set: value => { currentTime = value; media.paused = false; media.emit('play'); },
  });
  const player = new VizioHtml5Adapter(media);
  const opening = player.open({ url: 'https://gateway.example/clip.m3u8', kind: 'vod', paused: true, startAtSeconds: 37 });
  media.emit('loadedmetadata'); await opening;
  expect(media.paused).toBe(true);
  media.paused = false; media.emit('playing');
  expect(media.paused).toBe(true);
  expect(player.snapshot.state).toBe('paused');
  await player.play();
  expect(media.paused).toBe(false);
  expect(player.snapshot.state).toBe('playing');
  await player.dispose();
});

describe('TizenAvplayAdapter', () => {
  it('does not repeat SDK play/pause commands after open and retains pause across buffering', async () => {
    const avplay=new FakeAvplay(),player=new TizenAvplayAdapter(avplay);
    let opening=player.open({url:'https://media.example/paused.m3u8',kind:'vod',paused:true});
    avplay.prepareSuccess!();await opening;await player.pause();
    expect(avplay.pause).not.toHaveBeenCalled();
    opening=player.open({url:'https://media.example/playing.m3u8',kind:'vod'});
    avplay.prepareSuccess!();await opening;await player.play();
    expect(avplay.play).toHaveBeenCalledOnce();
    await player.pause();avplay.listener.onbufferingstart?.();avplay.listener.onbufferingcomplete?.();
    expect(player.snapshot.state).toBe('paused');
    expect(avplay.pause).toHaveBeenCalledOnce();
    await player.dispose();
  });
  it.each([false, true])('applies selected output subtitles only after PLAYING, including paused=%s', async paused => {
    const avplay = new FakeAvplay();
    avplay.tracks = [{ index: 8, type: 'TEXT', extra_info: '{"track_lang":"en"}' }];
    avplay.setSelectTrack.mockImplementation(() => { expect(avplay.play).toHaveBeenCalled(); });
    const player = new TizenAvplayAdapter(avplay);
    const opening = player.open({ url:'https://media.example/selected.m3u8',kind:'vod',paused,
      deliveryMode:'managed',preferredSubtitleLanguage:'eng' });
    avplay.prepareSuccess!();await opening;
    if (paused) {
      expect(avplay.setSelectTrack).not.toHaveBeenCalled();
      await player.play();
    }
    expect(avplay.setSelectTrack).toHaveBeenCalledWith('TEXT',8);
    expect(avplay.setSilentSubtitle).toHaveBeenCalledWith(false);
    expect(player.snapshot.tracks.selectedTextId).toBe('text:8');
    await player.stop();
    const calls=avplay.setSelectTrack.mock.calls.length;
    avplay.listener.oncurrentplaytime?.(1000);
    expect(avplay.setSelectTrack.mock.calls).toHaveLength(calls);
  });
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
    expect(player.snapshot.state).toBe('buffering');
    avplay.listener.oncurrentplaytime?.(45_500);
    expect(player.snapshot.state).toBe('playing');
    await player.pause();avplay.listener.onbufferingstart?.();avplay.listener.oncurrentplaytime?.(46_000);
    expect(player.snapshot.state).toBe('paused');
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

it('applies late native WebVTT selection, respects manual Off, and removes its track listener', async () => {
  const media = new FakeMedia();media.textTracks.length=0;
  let added!:()=>void;
  const remove=vi.fn();
  Object.assign(media.textTracks,{addEventListener:(_type:string,listener:()=>void)=>{added=listener;},removeEventListener:remove});
  const player=new VizioHtml5Adapter(media);
  const opening=player.open({url:'https://media.example/selected.mp4',kind:'vod',paused:true,preferredSubtitleLanguage:'spa'});
  media.emit('loadedmetadata');await opening;
  media.textTracks.push({kind:'metadata',label:'Markers',language:'',mode:'hidden'},
    {kind:'subtitles',label:'Spanish',language:'es',mode:'disabled'});
  added();
  expect(media.textTracks[1].mode).toBe('showing');
  expect(player.snapshot.tracks.selectedTextId).toBe('text:1');
  await player.selectTextTrack(null);added();
  expect(media.textTracks[1].mode).toBe('disabled');
  expect(media.textTracks[0].mode).toBe('hidden');
  await player.dispose();
  expect(remove).toHaveBeenCalledWith('addtrack',added);
});

it('honors explicit native subtitle Off even when the source marks a track showing', async () => {
  const media = new FakeMedia();media.textTracks[0].mode='showing';
  const player=new VizioHtml5Adapter(media);
  const opening=player.open({url:'https://media.example/default.mp4',kind:'vod',paused:true,textTrackId:null});
  media.emit('loadedmetadata');await opening;
  expect(media.textTracks[0].mode).toBe('disabled');
  expect(player.snapshot.tracks.selectedTextId).toBeNull();
  await player.dispose();
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

  it('publishes engine-reported buffered ranges on progress, shifted by the managed timeline offset', async () => {
    const media = new FakeMedia();
    const player = new VizioHtml5Adapter(media);
    // Gateway delivery starts the generated timeline at 600 while the media
    // element plays from zero; ranges must be reported on title time.
    const opening = player.open({ url: 'https://backend.example/managed.mp4', kind: 'vod', startAtSeconds: 600, timelineOffsetSeconds: 600 });
    media.emit('loadedmetadata');
    await opening;

    expect(media.listenerCount('progress')).toBe(1);
    expect(player.snapshot.time.bufferedRanges).toBeUndefined();
    media.currentTime = 10;
    media.buffered = {
      length: 2,
      start: (index) => [0, 50][index],
      end: (index) => [30, 80][index],
    };
    media.emit('progress');
    expect(player.snapshot.time.bufferedRanges).toEqual([
      { start: 600, end: 630 },
      { start: 650, end: 680 },
    ]);
    expect(player.snapshot.time.bufferedEndSeconds).toBe(680);

    // A stall that stops timeupdate must still advance the buffered window.
    media.buffered = { length: 1, start: () => 0, end: () => 95 };
    media.emit('progress');
    expect(player.snapshot.time.bufferedRanges).toEqual([{ start: 600, end: 695 }]);
    expect(player.snapshot.time.positionSeconds).toBe(610);

    // No engine ranges means no published ranges; the adapter never invents them.
    media.buffered = null;
    media.emit('progress');
    expect(player.snapshot.time.bufferedRanges).toBeUndefined();
    expect(player.snapshot.time.bufferedEndSeconds).toBeUndefined();
  });

  it('does not claim custom-header or audio-track support and rejects a request requiring them', async () => {
    const media = new FakeMedia();
    const player = new VizioHtml5Adapter(media);

    await expect(player.open({
      url: 'https://backend.example/direct.mp4',
      kind: 'vod',
      authorization: { cookie: 'session=private' },
    })).rejects.toMatchObject({ code: 'authorization-unsupported' });
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
