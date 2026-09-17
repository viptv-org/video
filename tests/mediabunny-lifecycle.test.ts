import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MediabunnyAdapter } from '../src/mediabunny';
const state = vi.hoisted(() => ({ live: true, duration: vi.fn(), dispose: vi.fn(), close: vi.fn(), draw: vi.fn() }));
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [], UrlSource: class {},
  Input: class {
    dispose = state.dispose;
    async getPrimaryVideoTrack() { return { canDecode: async () => true, getPrimaryPairableAudioTrack: async () => null, getDecoderConfig: async () => ({ codec: 'avc1.640029' }), getDisplayWidth: async () => 1920, getDisplayHeight: async () => 1080, getFirstTimestamp: async () => 1.4, isLive: async () => state.live, getDurationFromMetadata: state.duration }; }
  },
  CanvasSink: class { async getCanvas() { return { canvas: document.createElement('canvas'), timestamp: 1.4, duration: 0.04 }; } },
  AudioBufferSink: class {},
}));
beforeEach(() => {
  state.live = true; state.duration.mockReset().mockResolvedValue(101.4); state.dispose.mockReset(); state.close.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: state.draw } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('AudioContext', class { state = 'suspended'; destination = {}; createGain() { return { connect() {}, gain: { value: 1 } }; } close = state.close.mockResolvedValue(undefined); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('prepares growing managed VOD without waiting for the playlist to finish', async () => {
  state.duration.mockImplementation(() => new Promise(() => {}));
  const player = new MediabunnyAdapter(document.createElement('canvas'));
  await player.open({ url: `${location.origin}/media/session/cap/index.m3u8`, kind: 'vod', paused: true });
  expect(state.duration).not.toHaveBeenCalled();
  expect(player.snapshot).toMatchObject({ state: 'paused', time: { positionSeconds: 0, durationSeconds: null }, diagnostics: { engine: 'mediabunny', width: 1920, height: 1080 } });
  await player.dispose(); expect(state.dispose).toHaveBeenCalledOnce(); expect(state.close).toHaveBeenCalledOnce();
});
it('retains delivered timeline offsets, lets an original file refine the total, and unmutes a nonzero volume change', async () => {
  state.live = false;
  const player = new MediabunnyAdapter(document.createElement('canvas'));
  await player.open({ url: `${location.origin}/media/session/cap/source.mp4`, kind: 'vod', paused: true, startAtSeconds: 3, timelineOffsetSeconds: 50, timelineDurationSeconds: 140, adoptEngineDuration: true });
  expect(state.duration).toHaveBeenCalledWith({ skipLiveWait: true });
  // The file's own length is real evidence and may raise the server total (150), never fall below it (140).
  expect(player.snapshot.time).toEqual({ positionSeconds: 53, durationSeconds: 150 });
  await player.setMuted(true); await player.setVolume(0.6);
  expect(player.snapshot.volume).toEqual({ level: 0.6, muted: false }); await player.dispose();
});
it('reports the server total for managed output instead of its produced window', async () => {
  state.live = false;
  state.duration.mockResolvedValue(32);
  const player = new MediabunnyAdapter(document.createElement('canvas'));
  await player.open({ url: `${location.origin}/media/session/cap/index.m3u8`, kind: 'vod', paused: true, timelineDurationSeconds: 5400, adoptEngineDuration: false });
  // A rolling managed window never becomes the seek bar's length.
  expect(player.snapshot.time).toMatchObject({ durationSeconds: 5400 });
  await player.dispose();
});
it('never publishes the pre-seek decoded window when seeking backwards', async () => {
  state.live = false;
  const player = new MediabunnyAdapter(document.createElement('canvas'));
  await player.open({ url: `${location.origin}/media/session/cap/source.mp4`, kind: 'vod', paused: true, startAtSeconds: 60 });
  await player.seek(20);
  // The decoded window resets to the seek target before the time is
  // published, so a backwards seek must not flash the stale window that
  // reaches back up to the old position.
  expect(player.snapshot.time).toMatchObject({ positionSeconds: 20 });
  expect(player.snapshot.time.bufferedEndSeconds).toBeUndefined();
  await player.dispose();
});
