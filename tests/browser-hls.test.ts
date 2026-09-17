import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VizioHtml5Adapter } from '../src/vizio-html5';
import type { HtmlMediaLike } from '../src/vizio-html5';

const hls = vi.hoisted(() => ({ supported: true, instances: [] as Array<{ config: { xhrSetup: (xhr: unknown, url: string) => void }; destroy: ReturnType<typeof vi.fn>; loadSource: ReturnType<typeof vi.fn>; listeners: Record<string, (event: string, data: { fatal: boolean; type: string }) => void> }> }));
vi.mock('hls.js', () => ({ default: class {
  static isSupported = () => hls.supported;
  static Events = { ERROR: 'error' };
  static ErrorTypes = { NETWORK_ERROR: 'network' };
  destroy = vi.fn(); loadSource = vi.fn(); attachMedia = vi.fn();
  listeners: Record<string, (event: string, data: { fatal: boolean; type: string }) => void> = {};
  constructor(readonly config: { xhrSetup: (xhr: unknown, url: string) => void }) { hls.instances.push(this); }
  on(event: string, callback: (event: string, data: { fatal: boolean; type: string }) => void) { this.listeners[event] = callback; }
} }));
class Media implements HtmlMediaLike {
  src = ''; currentTime = 0; duration = 90; paused = true; ended = false; error: { code: number; message?: string } | null = null;
  nativeHls = false;
  events = new EventTarget();
  canPlayType = () => this.nativeHls ? 'probably' : '';
  play = vi.fn(async () => {}); pause = vi.fn(); load = vi.fn(() => { this.error = null; });
  removeAttribute = vi.fn(() => { this.src = ''; });
  addEventListener(event: string, listener: () => void) { this.events.addEventListener(event, listener); }
  removeEventListener(event: string, listener: () => void) { this.events.removeEventListener(event, listener); }
  emit(event: string) { this.events.dispatchEvent(new Event(event)); }
}
const url = () => `${window.location.origin}/media/session/cap/index.m3u8`;
beforeEach(() => { hls.supported = true; hls.instances.length = 0; });
describe('HTML HLS delivery', () => {
  it('prefers native HLS even when MSE is available', async () => {
    const media = new Media(); media.nativeHls = true;
    const player = new VizioHtml5Adapter(media);
    const opening = player.open({ url: url(), kind: 'vod', paused: true });
    media.emit('loadedmetadata'); await opening;
    expect(media.src).toBe(url()); expect(hls.instances).toHaveLength(0);
    await player.dispose();
  });
  it('uses hls.js when native HLS is unavailable and destroys it on replacement/stop', async () => {
    const media = new Media(); const player = new VizioHtml5Adapter(media);
    const first = player.open({ url: url(), kind: 'vod', paused: true });
    media.emit('loadedmetadata'); await first;
    expect(hls.instances[0].loadSource).toHaveBeenCalledWith(url());
    const second = player.open({ url: url(), kind: 'vod', paused: true });
    expect(hls.instances[0].destroy).toHaveBeenCalledOnce();
    media.emit('loadedmetadata'); await second;
    await player.stop(); expect(hls.instances[1].destroy).toHaveBeenCalledOnce();
  });
  it('keeps the server title duration while a managed HLS window grows', async () => {
    const media = new Media();
    const player = new VizioHtml5Adapter(media);
    const opening = player.open({ url: url(), kind: 'vod', paused: true, timelineOffsetSeconds: 1800, timelineDurationSeconds: 5400, adoptEngineDuration: false });
    media.duration = 32;
    media.emit('loadedmetadata'); await opening;
    expect(player.snapshot.time).toEqual({ positionSeconds: 1800, durationSeconds: 5400 });
    media.duration = 96; media.emit('timeupdate');
    expect(player.snapshot.time.durationSeconds).toBe(5400);
    await player.dispose();
  });
  it('lets an original file raise, but never shrink, the server duration', async () => {
    const media = new Media();
    const player = new VizioHtml5Adapter(media);
    const opening = player.open({ url: `${window.location.origin}/media/session/cap/source.mp4`, kind: 'vod', paused: true, timelineDurationSeconds: 5400, adoptEngineDuration: true });
    media.duration = 5402; media.emit('loadedmetadata'); await opening;
    expect(player.snapshot.time.durationSeconds).toBe(5402);
    media.duration = 64; media.emit('timeupdate');
    expect(player.snapshot.time.durationSeconds).toBe(5402);
    await player.dispose();
  });
  it('rejects unsupported HLS without loading a URL', async () => {
    hls.supported = false;
    const media = new Media(); const player = new VizioHtml5Adapter(media);
    await expect(player.open({ url: url(), kind: 'vod' })).rejects.toMatchObject({ code: 'unsupported-format' });
    expect(media.load).not.toHaveBeenCalled();
  });
  it('rejects external manifests and external or other-session subresources', async () => {
    const media = new Media(); const player = new VizioHtml5Adapter(media);
    await expect(player.open({ url: 'https://upstream.invalid/index.m3u8', kind: 'vod' })).rejects.toMatchObject({ code: 'authorization-unsupported' });
    const opening = player.open({ url: url(), kind: 'vod', paused: true });
    const setup = hls.instances[0].config.xhrSetup;
    expect(() => setup(null, `${window.location.origin}/media/session/cap/seg.ts`)).not.toThrow();
    expect(() => setup(null, 'https://upstream.invalid/seg.ts')).toThrow();
    expect(() => setup(null, `${window.location.origin}/media/other/cap/seg.ts`)).toThrow();
    media.emit('loadedmetadata'); await opening; await player.dispose();
  });
  it('surfaces fatal HLS errors and releases resources without unbounded recovery', async () => {
    const player = new VizioHtml5Adapter(new Media());
    const opening = player.open({ url: url(), kind: 'vod' });
    const rejection = expect(opening).rejects.toMatchObject({ code: 'connection-failed' });
    hls.instances[0].listeners.error('error', { fatal: true, type: 'network' });
    await rejection;
    expect(player.snapshot.state).toBe('error');
    expect(hls.instances[0].destroy).toHaveBeenCalledOnce();
  });
  it('retries a native HLS demux failure locally on the same session after metadata, preserving paused position', async () => {
    const media = new Media(); media.nativeHls = true;
    const player = new VizioHtml5Adapter(media);
    const opening = player.open({ url: url(), kind: 'vod', startAtSeconds: 37, paused: true, timelineOffsetSeconds: 100 });
    media.emit('loadedmetadata'); await opening;
    const sessionId = player.snapshot.sessionId;
    media.error = { code: 4, message: 'PipelineStatus::DEMUXER_ERROR_COULD_NOT_PARSE' };
    media.emit('error');
    expect(hls.instances).toHaveLength(1);
    expect(hls.instances[0].loadSource).toHaveBeenCalledWith(url());
    expect(player.snapshot).toMatchObject({ sessionId, state: 'buffering', error: null });
    media.emit('loadedmetadata');
    expect(media.currentTime).toBe(37);
    expect(media.play).not.toHaveBeenCalled();
    expect(player.snapshot).toMatchObject({ sessionId, state: 'paused', time: { positionSeconds: 137 } });
    hls.instances[0].listeners.error('error', { fatal: true, type: 'media' });
    expect(player.snapshot).toMatchObject({ state: 'error', error: { code: 'unsupported-format' } });
    media.emit('pause');
    expect(player.snapshot.state).toBe('error');
    expect(hls.instances).toHaveLength(1);
    await player.dispose();
  });
  it('cancels pending native-to-MSE recovery when stopped', async () => {
    const media = new Media(); media.nativeHls = true;
    const player = new VizioHtml5Adapter(media);
    const opening = player.open({ url: url(), kind: 'vod' });
    media.error = { code: 3 };
    media.emit('error');
    expect(hls.instances).toHaveLength(1);
    await player.stop();
    await opening;
    media.emit('loadedmetadata');
    expect(media.play).not.toHaveBeenCalled();
    expect(player.snapshot.state).toBe('stopped');
    expect(hls.instances[0].destroy).toHaveBeenCalledOnce();
    await player.dispose();
  });

});

it('rejects an audio-only black video session after a bounded first-frame wait and cancels the watch on stop', async () => {
  vi.useFakeTimers();
  try {
    const media = new Media(); media.nativeHls = true;
    Object.defineProperty(media, 'videoWidth', { configurable: true, value: 0 });
    const player = new VizioHtml5Adapter(media);
    const opening = player.open({ url: url(), kind: 'vod' }); media.emit('loadedmetadata'); await opening;
    await vi.advanceTimersByTimeAsync(8000);
    expect(player.snapshot).toMatchObject({ state: 'error', error: { code: 'unsupported-format' } });
    await player.stop(); await vi.advanceTimersByTimeAsync(8000); expect(player.snapshot.state).toBe('stopped'); await player.dispose();
  } finally { vi.useRealTimers(); }
});
it('does not reject a decoded first frame or an explicitly audio-only source', async () => {
  vi.useFakeTimers();
  try {
    for (const expectedVideo of [true, false]) {
      const media = new Media(); media.nativeHls = true;
      Object.defineProperty(media, 'videoWidth', { configurable: true, value: 0 });
      const player = new VizioHtml5Adapter(media);
      const opening = player.open({ url: url(), kind: 'vod', expectedVideo, paused: true }); media.emit('loadedmetadata'); await opening;
      if (expectedVideo) { Object.defineProperty(media, 'videoWidth', { configurable: true, value: 1920 }); media.emit('timeupdate'); }
      await vi.advanceTimersByTimeAsync(8000); expect(player.snapshot.state).toBe('paused'); await player.dispose();
    }
  } finally { vi.useRealTimers(); }
});
