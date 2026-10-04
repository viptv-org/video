import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MediabunnyAdapter } from '../src/mediabunny';
import { PlayerOperationError } from '../src/types';
import type { UrlSourceOptions } from 'mediabunny';
const state = vi.hoisted(() => ({ live: true, duration: vi.fn(), dispose: vi.fn(), close: vi.fn(), draw: vi.fn(), sourceOptions: undefined as UrlSourceOptions | undefined }));
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [], UrlSource: class { constructor(_url: string, options: UrlSourceOptions) { state.sourceOptions = options; } },
  Input: class {
    dispose = state.dispose;
    async getMetadataTags() { return {}; }
    async getVideoTracks() { return [await this.getPrimaryVideoTrack()]; }
    async getPrimaryVideoTrack() { return { id: 1, number: 1, getName: async () => '', getLanguageCode: async () => 'und', getPairableAudioTracks: async () => [], getAverageBitrate: async () => 1000000, getBitrate: async () => 1000000, hasOnlyKeyPackets: async () => false, hasHighDynamicRange: async () => false, getLiveRefreshInterval: async () => null, canDecode: async () => true, getPrimaryPairableAudioTrack: async () => null, getDecoderConfig: async () => ({ codec: 'avc1.640029' }), getDisplayWidth: async () => 1920, getDisplayHeight: async () => 1080, getFirstTimestamp: async () => 1.4, isLive: async () => state.live, getDurationFromMetadata: state.duration }; }
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
it('does not retry a direct network refusal before the controller can use its gateway fallback', async () => {
  const player = new MediabunnyAdapter(document.createElement('canvas'));
  await player.open({ url: `${location.origin}/media/session/cap/source.mp4`, kind: 'vod', paused: true, deliveryMode: 'direct' });
  expect(state.sourceOptions?.getRetryDelay).toBeTypeOf('function');
  expect(state.sourceOptions?.getRetryDelay?.(1, new PlayerOperationError('connection-failed', 'Media connection failed.', undefined, 'network'), 'https://source.example/movie')).toBeNull();
  await player.dispose();
});
it('retains transient managed HLS retries but never retries terminal authorization or delivery errors', async () => {
  const player = new MediabunnyAdapter(document.createElement('canvas'));
  await player.open({ url: `${location.origin}/media/session/cap/index.m3u8`, kind: 'vod', paused: true, deliveryMode: 'managed' });
  const retry = state.sourceOptions?.getRetryDelay;
  expect(retry).toBeTypeOf('function');
  expect(retry?.(1, new PlayerOperationError('connection-failed', 'Retry.', undefined, 'network'), 'https://gateway.example/segment')).toBe(.5);
  expect(retry?.(5, new Error('Transient read'), 'https://gateway.example/segment')).toBe(8);
  for (const code of ['authorization-failed', 'authorization-unsupported', 'expired-source', 'unsupported-format'] as const)
    expect(retry?.(1, new PlayerOperationError(code, 'Terminal refusal.'), 'https://gateway.example/segment')).toBeNull();
  await player.dispose();
});
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
