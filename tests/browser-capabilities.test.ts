import { describe, expect, it, vi } from 'vitest';
import { probeBrowserPlaybackCapabilities, type BrowserProbeEnvironment } from '../src/browser-capabilities';

const supported = { supported: true, smooth: true, powerEfficient: true, keySystemAccess: null };
const browser = (overrides: Partial<BrowserProbeEnvironment> = {}): BrowserProbeEnvironment => ({
  media: { canPlayType: () => 'probably' },
  decodingInfo: async () => supported,
  mseSupported: false,
  mseTypeSupported: () => false,
  ...overrides,
});

describe('browser decoder and protocol evidence', () => {
  it('does not claim codec support from a video element or WebCodecs existence', async () => {
    const result = await probeBrowserPlaybackCapabilities(browser({ media: { canPlayType: () => '' } }));
    expect(result.capabilities).toMatchObject({ h264: false, aac: false, hevc: false, directPlay: false, directMp4: false, directHls: false });
    expect(result.canPlayManagedHls).toBe(false);
  });
  it('probes native High 4.1 and HEVC Main 5.0, never exceeding tested dimensions', async () => {
    const decodingInfo = vi.fn(async () => supported);
    const result = await probeBrowserPlaybackCapabilities(browser({ decodingInfo }));
    expect(result.protocols.selectedHls).toBe('native');
    expect(result.capabilities).toMatchObject({ h264: true, hevc: true, aac: true, maxWidth: 1920, maxHeight: 1080 });
    expect(decodingInfo.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ type: 'file', video: expect.objectContaining({ contentType: 'video/mp4; codecs="avc1.640029"' }) })],
      [expect.objectContaining({ type: 'file', video: expect.objectContaining({ contentType: 'video/mp4; codecs="hvc1.1.6.L150.B0"' }) })],
    ]));
  });
  it('does not infer native MP4 from MSE support', async () => {
    const result = await probeBrowserPlaybackCapabilities(browser({ media: { canPlayType: () => '' }, mseSupported: true, mseTypeSupported: () => true }));
    expect(result.protocols.selectedHls).toBe('mse');
    expect(result.capabilities).toMatchObject({ h264: true, aac: true, hevc: false, directMp4: false, directHls: true });
    expect(result.canPlayManagedHls).toBe(true);
  });
  it('requires codec support in MSE as well as a working hls.js environment', async () => {
    const result = await probeBrowserPlaybackCapabilities(browser({ media: { canPlayType: (type) => type.includes('mp4') ? 'probably' : '' }, mseSupported: true, mseTypeSupported: () => false }));
    expect(result.capabilities.directMp4).toBe(true);
    expect(result.canPlayManagedHls).toBe(false);
    expect(result.capabilities.h264).toBe(false);
  });
  it('honors explicit MediaCapabilities rejection', async () => {
    const result = await probeBrowserPlaybackCapabilities(browser({ decodingInfo: async () => ({ ...supported, supported: false }) }));
    expect(result.canPlayManagedHls).toBe(false);
    expect(result.capabilities.directMp4).toBe(false);
  });
  it('re-probes a refused 1080p video sample at 720p before calling the browser incompatible', async () => {
    const decodingInfo = vi.fn(async (configuration: MediaDecodingConfiguration) =>
      configuration.video && configuration.video.height > 720 ? { ...supported, supported: false } : supported);
    const result = await probeBrowserPlaybackCapabilities(browser({ decodingInfo }));
    expect(result.capabilities).toMatchObject({ h264: true, hevc: true, aac: true });
    expect(result.canPlayManagedHls).toBe(true);
    expect(decodingInfo).toHaveBeenCalledWith(expect.objectContaining({
      video: expect.objectContaining({ width: 1280, height: 720, bitrate: 4000000, framerate: 30 }),
    }));
    expect(result.evidence).toContain('file:h264:decodingInfo-unsupported-1080p; supported-720p');
  });
  it('applies the 720p re-probe on the media-source path as well', async () => {
    const decodingInfo = vi.fn(async (configuration: MediaDecodingConfiguration) =>
      configuration.video && configuration.video.height > 720 ? { ...supported, supported: false } : supported);
    const result = await probeBrowserPlaybackCapabilities(
      browser({ media: { canPlayType: () => '' }, mseSupported: true, mseTypeSupported: () => true, decodingInfo }));
    expect(result.capabilities.h264).toBe(true);
    expect(result.evidence).toContain('media-source:h264:decodingInfo-unsupported-1080p; supported-720p');
  });
  it('treats a codec as supported when the 720p re-probe times out', async () => {
    const decodingInfo = vi.fn(async (configuration: MediaDecodingConfiguration) =>
      configuration.video && configuration.video.height > 720 ? { ...supported, supported: false } : new Promise<MediaCapabilitiesDecodingInfo>(() => {}));
    const result = await probeBrowserPlaybackCapabilities(browser({ decodingInfo, timeoutMs: 5 }));
    expect(result.capabilities.h264).toBe(true);
    expect(result.evidence).toContain('file:h264:decodingInfo-unsupported-1080p; decodingInfo-timeout-720p; mime-supported');
  });
  it('bounds unavailable MediaCapabilities calls and records the MIME-only evidence', async () => {
    const result = await probeBrowserPlaybackCapabilities(browser({ decodingInfo: () => new Promise(() => {}), timeoutMs: 5 }));
    expect(result.canPlayManagedHls).toBe(true);
    expect(result.evidence.some((value) => value.includes('timeout'))).toBe(true);
  });
});
