import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlayer,
  deliveryCapabilitiesFor,
  webDeliveryCapabilities,
  TAURI_NATIVE_DELIVERY_CAPABILITIES,
  TIZEN_DELIVERY_CAPABILITIES,
  VIZIO_DELIVERY_CAPABILITIES,
} from '../src/index';
import { TizenAvplayAdapter, type AvplayListener, type AvplayTrackInfo } from '../src/tizen-avplay';
import { VizioHtml5Adapter } from '../src/vizio-html5';

const tracking = vi.hoisted(() => ({
  probes: 0,
  managedHls: true,
  mediabunnyInstances: [] as unknown[],
}));

vi.mock('../src/browser-capabilities', () => ({
  supportsNativeHls: () => true,
  probeBrowserPlaybackCapabilities: async () => {
    tracking.probes += 1;
    return {
      canPlayManagedHls: tracking.managedHls,
      capabilities: {
        maxWidth: 4096,
        maxHeight: 2160,
        h264: true,
        hevc: false,
        aac: true,
        directPlay: true,
        hevcSdr: false,
        directFiles: true,
        directVideoCodecs: ['avc'],
        directAudioCodecs: ['aac'],
      },
      protocols: { nativeHls: true, mseHls: true, selectedHls: 'native' as const },
      evidence: [],
    };
  },
}));

vi.mock('../src/mediabunny', () => ({
  MediabunnyAdapter: class {
    constructor() {
      tracking.mediabunnyInstances.push(this);
    }
  },
}));

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
}

class FakeAvplay {
  listener: AvplayListener = {};
  tracks: AvplayTrackInfo[] = [
    { index: 1, type: 'AUDIO', extra_info: '{"language":"eng"}' },
    { index: 2, type: 'TEXT', extra_info: '{"language":"spa"}' },
  ];
  prepareSuccess?: () => void;
  open = vi.fn();
  close = vi.fn();
  play = vi.fn();
  pause = vi.fn();
  stop = vi.fn();
  getCurrentTime = vi.fn(() => 12_000);
  getDuration = vi.fn(() => 120_000);
  setListener = vi.fn((listener: AvplayListener) => { this.listener = listener; });
  prepareAsync = vi.fn((success: () => void) => { this.prepareSuccess = success; });
  seekTo = vi.fn((_: number, success?: () => void) => { success?.(); });
  getTotalTrackInfo = vi.fn(() => this.tracks);
  setSelectTrack = vi.fn();
  setSilentSubtitle = vi.fn();
  setStreamingProperty = vi.fn();
  setDisplayRect = vi.fn();
}


describe('delivery profile dispatch', () => {
  beforeEach(() => {
    tracking.probes = 0;
    tracking.managedHls = true;
    tracking.mediabunnyInstances.length = 0;
  });

  it('resolves the declared TV and desktop profiles without consulting a browser probe', async () => {
    expect(await deliveryCapabilitiesFor('tizen')()).toBe(TIZEN_DELIVERY_CAPABILITIES);
    expect(await deliveryCapabilitiesFor('vizio')()).toBe(VIZIO_DELIVERY_CAPABILITIES);
    expect(await deliveryCapabilitiesFor('tauri')()).toBe(TAURI_NATIVE_DELIVERY_CAPABILITIES);
    expect(tracking.probes).toBe(0);
  });

  it('creates the engine each entry point is profiled for', () => {
    expect(createPlayer({ platform: 'tizen', avplay: new FakeAvplay() })).toBeInstanceOf(TizenAvplayAdapter);
    expect(createPlayer({ platform: 'vizio', video: new FakeMedia() })).toBeInstanceOf(VizioHtml5Adapter);
  });

  it('declares the server-ladder envelopes each platform intends', () => {
    // Tizen: native H.264/HEVC Main-SDR envelope to 1080p; the WebCodecs
    // original-container rung stays off.
    expect(TIZEN_DELIVERY_CAPABILITIES).toEqual({
      maxWidth: 1920,
      maxHeight: 1080,
      h264: true,
      hevc: true,
      aac: true,
      directPlay: true,
      hevcSdr: true,
    });
    // Vizio: only the measured H.264/AAC baseline is claimed; HEVC stays
    // unclaimed and the original-container rung stays off, so everything the
    // envelope refuses is served through managed delivery.
    expect(VIZIO_DELIVERY_CAPABILITIES).toEqual({
      maxWidth: 1920,
      maxHeight: 1080,
      h264: true,
      hevc: false,
      aac: true,
      directPlay: true,
      hevcSdr: false,
    });
    expect(VIZIO_DELIVERY_CAPABILITIES.directFiles).toBeUndefined();
    // Desktop: direct play only, with the original container allowed for the
    // native demuxer.
    expect(TAURI_NATIVE_DELIVERY_CAPABILITIES).toMatchObject({ directPlay: true, directFiles: true });
  });

  it('measures the web profile through the browser probe and memoizes it', async () => {
    const first = await deliveryCapabilitiesFor('html5')();
    expect(tracking.probes).toBe(1);
    expect(first).toEqual({
      maxWidth: 4096,
      maxHeight: 2160,
      h264: true,
      hevc: false,
      aac: true,
      directPlay: true,
      hevcSdr: false,
      directFiles: true,
      directVideoCodecs: ['avc'],
      directAudioCodecs: ['aac'],
    });
    expect(await webDeliveryCapabilities()).toBe(first);
    expect(tracking.probes).toBe(1);
  });

  it('rejects a web browser that cannot play the managed output', async () => {
    vi.resetModules();
    tracking.managedHls = false;
    const { webDeliveryCapabilities: fresh } = await import('../src/platform-profiles');
    await expect(fresh()).rejects.toThrow('cannot play the supported H.264/AAC streaming output');
    tracking.managedHls = true;
  });
});

describe('the Vizio cast-receiver path', () => {
  beforeEach(() => {
    tracking.probes = 0;
    tracking.managedHls = true;
    tracking.mediabunnyInstances.length = 0;
  });

  it('plays through the HTML/HLS engine only, never a mediabunny/WebCodecs engine', async () => {
    const media = new FakeMedia();
    const player = createPlayer({ platform: 'vizio', video: media });
    expect(player).toBeInstanceOf(VizioHtml5Adapter);

    const opening = player.open({ url: 'https://backend.example/media/session/source.mp4', kind: 'vod' });
    media.emit('loadedmetadata');
    await opening;

    expect(media.src).toBe('https://backend.example/media/session/source.mp4');
    expect(player.snapshot.diagnostics?.engine).toBe('native-html');
    // The WebCodecs engine was never constructed and no decoder probe ran:
    // the receiver resolves its delivery profile statically.
    expect(tracking.mediabunnyInstances).toHaveLength(0);
    expect(tracking.probes).toBe(0);
  });
});
