import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Html5FallbackAdapter } from '../src/html5-fallback';
import { IDLE_SNAPSHOT, type PlayerListener, type PlayerSnapshot, type OpenPlayerRequest } from '../src/types';
const state = vi.hoisted(() => ({ reject: false, pending: false, instances: [] as Array<{ emit(snapshot: PlayerSnapshot): void; disposed: boolean; request?: OpenPlayerRequest }> }));
vi.mock('../src/mediabunny', () => ({ MediabunnyAdapter: class {
  snapshot = IDLE_SNAPSHOT; listeners = new Set<PlayerListener>(); disposed = false; request?: OpenPlayerRequest;
  constructor() { state.instances.push(this); }
  subscribe(fn: PlayerListener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(snapshot: PlayerSnapshot) { this.snapshot = snapshot; this.listeners.forEach(fn => fn(snapshot)); }
  async open(request: OpenPlayerRequest) { this.request = request; if (state.pending) return new Promise<void>(() => {}); if (state.reject) throw Error('Unsupported codec'); this.emit({ ...IDLE_SNAPSHOT, sessionId: 1, kind: request.kind, state: request.paused ? 'paused' : 'playing', time: { positionSeconds: (request.startAtSeconds ?? 0) + (request.timelineOffsetSeconds ?? 0), durationSeconds: 100 }, diagnostics: { engine: 'mediabunny', transport: 'file' } }); }
  async dispose() { this.disposed = true; }
  async pause() {} async play() {} async seek() {} async setVolume() {} async setMuted() {}
} }));
function media() {
  const video = document.createElement('video');
  vi.spyOn(video, 'pause').mockImplementation(() => {});
  vi.spyOn(video, 'load').mockImplementation(() => { queueMicrotask(() => video.dispatchEvent(new Event('loadedmetadata'))); });
  vi.spyOn(video, 'play').mockResolvedValue();
  Object.defineProperty(video, 'duration', { value: 100 });
  return video;
}
const request = { url: `${location.origin}/media/lease/cap/movie.mp4`, kind: 'vod' as const, startAtSeconds: 12, timelineOffsetSeconds: 50, paused: true };
beforeEach(() => { state.reject = false; state.pending = false; state.instances.length = 0; vi.stubGlobal('isSecureContext', true); vi.stubGlobal('VideoDecoder', class {}); vi.stubGlobal('AudioDecoder', class {}); vi.stubGlobal('AudioContext', class {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('real MediaBunny preference and local fallback boundary', () => {
  it('uses decoded-sample backend instead of assigning the video URL when available', async () => {
    const video = media(), canvas = document.createElement('canvas');
    const player = new Html5FallbackAdapter(video, canvas); await player.open(request);
    expect(player.snapshot.diagnostics?.engine).toBe('mediabunny'); expect(video.getAttribute('src')).toBeNull();
    expect(player.snapshot.time.positionSeconds).toBe(62); expect(player.snapshot.state).toBe('paused');
    await player.dispose(); expect(state.instances[0].disposed).toBe(true);
  });
  it('falls back on unsupported decoder with same URL, position and pause intent and truthful engine', async () => {
    state.reject = true; const video = media(); const player = new Html5FallbackAdapter(video, document.createElement('canvas'));
    await player.open(request);
    expect(video.src).toBe(request.url); expect(video.currentTime).toBe(12);
    expect(player.snapshot.time.positionSeconds).toBe(62); expect(player.snapshot.state).toBe('paused');
    expect(player.snapshot.diagnostics).toMatchObject({ engine: 'native-html', networkTransport: 'browser-proxy', fallbackReason: expect.any(String) });
    expect(state.instances[0].disposed).toBe(true); await player.dispose();
  });
  it('does not instantiate WebCodecs on insecure LAN and supports truthful native volume', async () => {
    vi.stubGlobal('isSecureContext', false); const video = media(); const player = new Html5FallbackAdapter(video, document.createElement('canvas'));
    await player.open(request); await player.setVolume(0.4); await player.setMuted(true);
    expect(state.instances).toHaveLength(0); expect(player.snapshot.volume).toEqual({ level: 0.4, muted: true });
    expect(player.snapshot.diagnostics?.fallbackReason).toContain('HTTPS'); await player.dispose();
  });
  it('stopping a pending decoder open settles it and prevents late fallback', async () => {
    state.pending = true; const video = media(); const player = new Html5FallbackAdapter(video, document.createElement('canvas'));
    const opening = player.open(request); await vi.waitFor(() => expect(state.instances).toHaveLength(1));
    await player.stop(); await opening;
    expect(state.instances[0].disposed).toBe(true); expect(video.getAttribute('src')).toBeNull(); expect(player.snapshot.state).toBe('stopped');
  });
  it('recovers a later decoder failure at the observed absolute position without a new backend session', async () => {
    const video = media(); const player = new Html5FallbackAdapter(video, document.createElement('canvas'));
    await player.open({ ...request, paused: false });
    state.instances[0].emit({ ...player.snapshot, state: 'error', time: { positionSeconds: 77, durationSeconds: 100 }, error: { code: 'unsupported-format', message: 'Decoder failed' } });
    await vi.waitFor(() => expect(player.snapshot.diagnostics?.engine).toBe('native-html'));
    expect(video.src).toBe(request.url); expect(video.currentTime).toBe(27); expect(state.instances[0].disposed).toBe(true); await player.dispose();
  });
});
