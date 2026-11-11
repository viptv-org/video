import { describe, expect, it } from 'vitest';
import { TizenAvplayAdapter, type AvplayListener } from '../src/tizen-avplay';
import { PlaybackSessionController } from '../src/session';
import type { PlaybackSessionView } from '../src/types';

class SeekingAvplay {
  state = 'NONE';
  listener: AvplayListener = {};
  calls: string[] = [];
  violations: string[] = [];
  position = 0;
  pending?: { position: number; success?: () => void; error?: (cause: unknown) => void };

  private call(name: string): void {
    if (this.pending) {
      this.violations.push(name);
      throw new Error('AVPlay API unavailable until seek callback');
    }
    this.calls.push(name);
  }
  open = (_url: string) => { this.call('open'); this.state = 'IDLE'; };
  close = () => { this.call('close'); this.state = 'NONE'; };
  stop = () => { this.call('stop'); this.state = 'IDLE'; };
  play = () => { this.call('play'); this.state = 'PLAYING'; };
  pause = () => { this.call('pause'); this.state = 'PAUSED'; };
  prepareAsync = (success: () => void) => { this.call('prepare'); this.state = 'READY'; success(); };
  setListener = (listener: AvplayListener) => { this.call('listener'); this.listener = listener; };
  getDuration = () => { this.call('duration'); return 120_000; };
  getCurrentTime = () => { this.call('time'); return this.position; };
  getTotalTrackInfo = () => {
    this.call('tracks');
    return [{ index: 1, type: 'AUDIO' as const, extra_info: '{}' }, { index: 2, type: 'TEXT' as const, extra_info: '{}' }];
  };
  setSelectTrack = (type: string, index: number) => { this.call(`${type}:${index}`); };
  setSilentSubtitle = (silent: boolean) => { this.call(`silent:${silent}`); };
  seekTo = (position: number, success?: () => void, error?: (cause: unknown) => void) => {
    this.call(`seek:${position}`);
    this.pending = { position, success, error };
  };
  finishSeek(failed = false): void {
    const pending = this.pending!;
    this.pending = undefined;
    if (failed) pending.error?.(new Error('seek refused'));
    else { this.position = pending.position; pending.success?.(); }
  }
}

const source = { url: 'https://media.example/fixture.m3u8', kind: 'vod' as const };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('AVPlay asynchronous seek boundary', () => {
  it.each([false, true])('Stop waits for the SDK callback, including failure=%s', async failed => {
    const sdk = new SeekingAvplay(), player = new TizenAvplayAdapter(sdk);
    await player.open(source);
    const seeking = player.seek(10).catch(error => error);
    await flush();
    let stopped = false;
    const stopping = player.stop().then(() => { stopped = true; });
    await flush();
    expect(stopped).toBe(false);
    expect(sdk.violations).toEqual([]);
    sdk.finishSeek(failed);
    await Promise.all([seeking, stopping]);
    expect(sdk.state).toBe('NONE');
    expect(player.snapshot.state).toBe('stopped');
    expect(sdk.violations).toEqual([]);
  });

  it('opens only the newest replacement after a pending seek and ignores old callbacks', async () => {
    const sdk = new SeekingAvplay(), player = new TizenAvplayAdapter(sdk);
    await player.open(source);
    const oldListener = sdk.listener;
    const seeking = player.seek(10);
    await flush();
    const stopping = player.stop();
    const superseded = player.open({ ...source, url: 'https://media.example/superseded.m3u8' });
    const latest = player.open({ ...source, paused: true });
    await flush();
    expect(sdk.calls.filter(call => call === 'open')).toHaveLength(1);
    sdk.finishSeek();
    await Promise.all([seeking, stopping, superseded, latest]);
    oldListener.onerror?.('old error'); oldListener.oncurrentplaytime?.(90_000);
    expect(sdk.calls.filter(call => call === 'open')).toHaveLength(2);
    expect(sdk.state).toBe('READY');
    expect(player.snapshot.state).toBe('paused');
    expect(player.snapshot.time.positionSeconds).toBe(0);
    expect(sdk.violations).toEqual([]);
  });

  it('cancels a startup seek without starting playback after Stop', async () => {
    const sdk = new SeekingAvplay(), player = new TizenAvplayAdapter(sdk);
    const opening = player.open({ ...source, startAtSeconds: 30 });
    await flush();
    const stopping = player.stop();
    sdk.finishSeek();
    await Promise.all([opening, stopping]);
    expect(sdk.calls).not.toContain('play');
    expect(sdk.state).toBe('NONE');
    expect(sdk.violations).toEqual([]);
  });

  it('serializes rapid seeks and defers pause and track controls until each seek settles', async () => {
    const sdk = new SeekingAvplay(), player = new TizenAvplayAdapter(sdk);
    await player.open(source);
    const first = player.seek(10);
    await flush();
    const second = player.seek(20);
    const audio = player.selectAudioTrack('audio:1');
    const subtitles = player.selectTextTrack('text:2');
    const pausing = player.pause();
    sdk.listener.oncurrentplaytime?.(5000);
    await flush();
    expect(sdk.violations).toEqual([]);
    sdk.finishSeek(); await first; await flush();
    expect(sdk.pending?.position).toBe(20_000);
    expect(sdk.violations).toEqual([]);
    sdk.finishSeek();
    await Promise.all([second, pausing, audio, subtitles]);
    expect(player.snapshot.state).toBe('paused');
    expect(player.snapshot.tracks.selectedAudioId).toBe('audio:1');
    expect(player.snapshot.tracks.selectedTextId).toBe('text:2');
    expect(sdk.violations).toEqual([]);
    await player.stop();
  });

  it('keeps healthy playback when the SDK refuses a seek', async () => {
    const sdk = new SeekingAvplay(), player = new TizenAvplayAdapter(sdk);
    await player.open(source);
    const seeking = player.seek(10);
    await flush(); sdk.finishSeek(true);
    await expect(seeking).rejects.toMatchObject({ code: 'seek-failed' });
    expect(player.snapshot.state).toBe('playing');
    expect(player.snapshot.error).toBeNull();
    await player.stop();
  });

  it('releases the backend lease while native Stop waits for seek completion', async () => {
    const sdk = new SeekingAvplay(), player = new TizenAvplayAdapter(sdk);
    const released: string[] = [];
    const admitted: PlaybackSessionView = { id: 'lease', url: source.url, headers: {}, format: 'mp4', mode: 'direct',
      videoMode: 'copy', audioMode: 'copy', position: 0, live: false, duration: 120,
      audioTracks: [], subtitleTracks: [], subtitlesSupported: false };
    const controller = new PlaybackSessionController({ player,
      capabilities: { maxWidth: 1920, maxHeight: 1080, h264: true, hevc: false, hevcSdr: false, aac: true, directPlay: true },
      backend: { startPlayback: async () => admitted, stopPlayback: async id => { released.push(id); } } });
    await controller.start({ item: { id: 'movie', type: 'movie' }, source: { id: 'chosen-source' } });
    const seeking = controller.seek(10);
    await flush();
    const stopping = controller.stop();
    await flush();
    expect(released).toEqual(['lease']);
    expect(controller.snapshot).toMatchObject({ state: 'stopped', active: null });
    expect(sdk.state).toBe('PLAYING');
    sdk.finishSeek();
    await Promise.all([seeking, stopping]);
    expect(sdk.state).toBe('NONE');
    expect(sdk.violations).toEqual([]);
  });

  it('keeps an older Dispose and queued controls from changing a newer source', async () => {
    const sdk = new SeekingAvplay(), player = new TizenAvplayAdapter(sdk);
    await player.open(source);
    const seeking = player.seek(10);
    await flush();
    const pausing = player.pause();
    const audio = player.selectAudioTrack('audio:1');
    const disposing = player.dispose();
    const opening = player.open(source);
    sdk.finishSeek();
    await Promise.all([seeking, pausing, audio, disposing, opening]);
    expect(player.snapshot.state).toBe('playing');
    expect(sdk.state).toBe('PLAYING');
    expect(sdk.calls).not.toContain('pause');
    expect(sdk.calls).not.toContain('AUDIO:1');
    expect(sdk.violations).toEqual([]);
    await player.stop();
  });


  it('retains paused startup intent across an asynchronous resume seek', async () => {
    const sdk = new SeekingAvplay(), player = new TizenAvplayAdapter(sdk);
    const opening = player.open({ ...source, startAtSeconds: 30, paused: true });
    await flush();
    const pausing = player.pause();
    sdk.finishSeek();
    await Promise.all([opening, pausing]);
    expect(player.snapshot.state).toBe('paused');
    expect(player.snapshot.time.positionSeconds).toBe(30);
    expect(sdk.state).toBe('READY');
    expect(sdk.calls).not.toContain('pause');
    expect(sdk.calls).not.toContain('play');
    await player.play();
    expect(sdk.state).toBe('PLAYING');
    expect(sdk.violations).toEqual([]);
    await player.stop();
  });

  it('releases the seek fence after a synchronous SDK refusal', async () => {
    const sdk = new SeekingAvplay(), player = new TizenAvplayAdapter(sdk);
    await player.open(source);
    sdk.seekTo = () => { throw new Error('seek unavailable'); };
    await expect(player.seek(10)).rejects.toMatchObject({ code: 'seek-failed' });
    expect(player.snapshot.state).toBe('playing');
    await player.stop();
    expect(sdk.state).toBe('NONE');
  });


  it('ignores duplicate callbacks from an older SDK seek while a newer seek is pending', async () => {
    const sdk = new SeekingAvplay(), player = new TizenAvplayAdapter(sdk);
    await player.open(source);
    const first = player.seek(10);
    await flush();
    const oldCallbacks = sdk.pending!;
    sdk.finishSeek(); await first;
    const second = player.seek(20);
    await flush();
    oldCallbacks.success?.(); oldCallbacks.error?.(new Error('stale refusal'));
    const stopping = player.stop();
    await flush();
    expect(sdk.violations).toEqual([]);
    expect(sdk.pending?.position).toBe(20_000);
    sdk.finishSeek();
    await Promise.all([second, stopping]);
    expect(sdk.state).toBe('NONE');
  });

});
