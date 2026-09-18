import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlayer } from '../src';
import {
  TAURI_NATIVE_DELIVERY_CAPABILITIES,
  TAURI_VIDEO_PROTOCOL_VERSION,
  TauriNativeAdapter,
  tauriNativePlatform,
  type NativeVideoDiagnostics,
  type NativeVideoEngine,
  type NativeVideoSnapshot,
  type NativeVideoTrack,
} from '../src/tauri-native';

function baseSnapshot(overrides: Partial<NativeVideoSnapshot> = {}): NativeVideoSnapshot {
  return {
    durationSeconds: 600,
    currentTimeSeconds: 0,
    bufferedSeconds: 240,
    live: false,
    seekable: true,
    seekableStartSeconds: 0,
    seekableEndSeconds: 600,
    playing: false,
    videoWidth: 1920,
    videoHeight: 1080,
    tracks: [
      { id: 'video-0', index: 0, kind: 'video', language: '', label: '', codec: 'h264', selected: true },
      { id: 'audio-1', index: 1, kind: 'audio', language: 'eng', label: 'English', codec: 'aac', selected: true },
      { id: 'text-2', index: 2, kind: 'subtitle', language: 'spa', label: 'Spanish', codec: 'subrip', selected: false },
    ],
    ...overrides,
  };
}

function last<T>(values: readonly T[]): T {
  return values[values.length - 1];
}

/** Records every plugin command and answers the way the Rust engine would. */
class FakeTauriVideoPlugin {
  diagnostics: NativeVideoDiagnostics = {
    protocolVersion: TAURI_VIDEO_PROTOCOL_VERSION,
    crateName: 'tauri-plugin-video',
    crateVersion: '0.4.0',
    platform: 'linux',
  };
  openSnapshot: NativeVideoSnapshot = baseSnapshot({ playing: true });
  openError: unknown;

  /** Per-attempt open errors, consumed front-first; the persistent openError applies after the queue empties. */
  openErrorQueue: unknown[] = [];
  controlError: unknown;
  statsSnapshot: NativeVideoSnapshot | undefined;
  statsError: unknown;
  readonly openedPayloads: Array<Record<string, unknown>> = [];
  readonly controls: Array<{ sessionKey: string; action: string; value: number; index: number }> = [];
  readonly layouts: Array<Record<string, unknown>> = [];
  readonly closedKeys: string[] = [];
  #current = 0;
  #playing = false;
  #tracks: readonly NativeVideoTrack[] = baseSnapshot().tracks;

  readonly commands: string[] = [];
  /** When set, the engine answers seeks by replaying from ~0: an origin that cannot serve range requests. */
  seekReplaysFromBeginning = false;

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.commands.push(command);
    if (command === 'plugin:video|native_diagnostics') return this.diagnostics as T;
    if (command === 'plugin:video|native_open') {
      const payload = (args?.payload ?? {}) as Record<string, unknown>;
      this.openedPayloads.push(payload);
      const failure = this.openErrorQueue.length > 0 ? this.openErrorQueue.shift() : this.openError;
      if (failure) throw failure;
      this.#playing = payload.autoplay === true;
      this.#current = 0;
      this.#tracks = this.openSnapshot.tracks;
      return this.openSnapshot as T;
    }
    if (command === 'plugin:video|native_control') {
      const payload = (args?.payload ?? {}) as { sessionKey: string; action: string; value: number; index: number };
      this.controls.push(payload);
      if (this.controlError) throw this.controlError;
      this.#apply(payload.action, payload.value, payload.index);
      return this.#snapshot() as T;
    }
    if (command === 'plugin:video|native_stats') {
      if (this.statsError) throw this.statsError;
      return (this.statsSnapshot ?? this.#snapshot()) as T;
    }
    if (command === 'plugin:video|native_layout') {
      this.layouts.push((args?.payload ?? {}) as Record<string, unknown>);
      return null as T;
    }
    if (command === 'plugin:video|native_close') {
      this.closedKeys.push(((args?.payload ?? {}) as { sessionKey: string }).sessionKey);
      return null as T;
    }
    throw new Error(`unexpected command ${command}`);
  }

  #apply(action: string, value: number, index: number): void {
    if (action === 'play') this.#playing = true;
    else if (action === 'pause') this.#playing = false;
    else if (action === 'seek') this.#current = this.seekReplaysFromBeginning ? 1.0 : value;
    else if (action === 'track') {
      this.#tracks = this.#tracks.map(track => track.index === index ? { ...track, selected: true } : track);
    } else if (action === 'deselectTrack') {
      this.#tracks = this.#tracks.map(track => track.index === index ? { ...track, selected: false } : track);
    }
  }

  #snapshot(): NativeVideoSnapshot {
    return {
      ...this.openSnapshot,
      currentTimeSeconds: this.#current,
      bufferedSeconds: Math.max(this.#current, this.openSnapshot.bufferedSeconds),
      playing: this.#playing,
      tracks: this.#tracks,
    };
  }
}

function createAdapter(
  plugin: FakeTauriVideoPlugin,
  options: { engine?: NativeVideoEngine } = {},
): { player: TauriNativeAdapter; anchor: HTMLVideoElement } {
  const anchor = document.createElement('video');
  return { player: new TauriNativeAdapter(anchor, plugin, { platform: 'linux', engine: options.engine }), anchor };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TauriNativeAdapter', () => {
  it('runs the Linux native path in this test runtime', () => {
    expect(tauriNativePlatform()).toBe('linux');
  });

  it('verifies the protocol, opens the exact selected source, and reports engine tracks', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player, anchor } = createAdapter(plugin);
    // A direct original-file delivery: only then may the engine raise the duration.
    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod', adoptEngineDuration: true });

    expect(plugin.commands[0]).toBe('plugin:video|native_diagnostics');
    expect(plugin.openedPayloads[0]).toMatchObject({
      protocolVersion: TAURI_VIDEO_PROTOCOL_VERSION,
      packageVersion: expect.any(String),
      sessionKey: expect.any(String),
      uri: 'https://backend.example/media/direct.mp4',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      scrollX: 0,
      scrollY: 0,
      autoplay: true,
      volume: 1,
      muted: false,
      startAtSeconds: 0,
    });
    expect(player.snapshot.state).toBe('playing');
    expect(player.snapshot.diagnostics).toMatchObject({
      engine: 'tauri-native',
      transport: 'file',
      networkTransport: 'direct',
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
    });
    expect(player.snapshot.tracks.audio).toEqual([expect.objectContaining({ id: 'audio:1', language: 'eng' })]);
    expect(player.snapshot.tracks.text).toEqual([expect.objectContaining({ id: 'text:2', language: 'spa' })]);
    expect(player.snapshot.tracks.selectedAudioId).toBe('audio:1');
    expect(player.snapshot.time).toMatchObject({ positionSeconds: 0, durationSeconds: 600, bufferedEndSeconds: 240 });
    // The native surface replaces the anchor: it is hidden and the page stack
    // above it turns transparent while the session is live.
    expect(anchor.style.visibility).toBe('hidden');
    expect(document.documentElement.classList.contains('tauri-native-video')).toBe(true);

    await player.stop();
    expect(plugin.closedKeys).toHaveLength(1);
    expect(anchor.style.visibility).toBe('');
    expect(document.documentElement.classList.contains('tauri-native-video')).toBe(false);
    expect(player.snapshot.state).toBe('stopped');
  });

  it('plays, pauses, seeks, changes volume, and selects engine tracks', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod' });

    await player.pause();
    expect(last(plugin.controls)).toMatchObject({ action: 'pause', value: 0, index: -1 });
    expect(player.snapshot.state).toBe('paused');
    await player.play();
    expect(last(plugin.controls)).toMatchObject({ action: 'play' });
    expect(player.snapshot.state).toBe('playing');
    await player.seek(120);
    expect(last(plugin.controls)).toMatchObject({ action: 'seek', value: 120 });
    expect(player.snapshot.time.positionSeconds).toBe(120);
    await player.setVolume(0.5);
    expect(last(plugin.controls)).toMatchObject({ action: 'volume', value: 0.5 });
    expect(player.snapshot.volume).toEqual({ level: 0.5, muted: false });
    await player.setMuted(true);
    expect(last(plugin.controls)).toMatchObject({ action: 'volume', value: 0 });
    expect(player.snapshot.volume?.muted).toBe(true);
    await player.selectAudioTrack('audio:1');
    expect(last(plugin.controls)).toMatchObject({ action: 'track', index: 1 });
    await player.selectTextTrack('text:2');
    expect(last(plugin.controls)).toMatchObject({ action: 'track', index: 2 });
    expect(player.snapshot.tracks.selectedTextId).toBe('text:2');
    await player.selectTextTrack(null);
    expect(last(plugin.controls)).toMatchObject({ action: 'deselectTrack', index: 2 });
    expect(player.snapshot.tracks.selectedTextId).toBeNull();
    await expect(player.selectAudioTrack('audio:404')).rejects.toMatchObject({ code: 'unsupported-operation' });
    await player.stop();
  });

  it('publishes engine seekability and still attempts seeks on unseekable media', async () => {
    const plugin = new FakeTauriVideoPlugin();
    plugin.openSnapshot = baseSnapshot({ playing: true, seekable: false });
    const { player } = createAdapter(plugin);
    // A VOD from an origin without range support: the engine reads the
    // duration from the container but cannot seek the stream.
    await player.open({ url: 'https://backend.example/media/unseekable.mp4', kind: 'vod' });

    expect(player.snapshot.time.seekable).toBe(false);
    await player.seek(120);
    expect(last(plugin.controls)).toMatchObject({ action: 'seek', value: 120 });
    expect(player.snapshot.time.positionSeconds).toBe(120);
    await player.stop();
  });

  it('refuses seeks outside the reported window on unseekable media instead of replaying the beginning', async () => {
    const plugin = new FakeTauriVideoPlugin();
    plugin.openSnapshot = baseSnapshot({ playing: true, seekable: false, seekableEndSeconds: 4 });
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/unseekable.mp4', kind: 'vod' });

    // Inside the engine's window (mpv's demuxer cache): the seek still goes.
    await player.seek(2);
    expect(last(plugin.controls)).toMatchObject({ action: 'seek', value: 2 });
    // Beyond it: an honest refusal — dispatching the seek would make the
    // origin replay the beginning instead of landing the target.
    await expect(player.seek(120)).rejects.toMatchObject({ code: 'seek-failed' });
    expect(plugin.controls).toHaveLength(1);
    // The session stays healthy; the refusal is not a session failure.
    expect(player.snapshot.state).toBe('playing');
    expect(player.snapshot.error).toBeNull();
    await player.stop();
  });

  it('reports an honest failure when the origin replays the beginning instead of landing the seek', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod', startAtSeconds: 30 });
    // The origin starts lying only after playback is underway: it answers
    // the seek's range request by replaying the stream from the beginning.
    plugin.seekReplaysFromBeginning = true;

    await expect(player.seek(90)).rejects.toMatchObject({
      code: 'seek-failed',
      message: expect.stringContaining('replayed'),
    });
    // The engine keeps playing: a failed seek is an operation failure, not
    // a session failure, so the error cannot loop the UI every poll.
    expect(player.snapshot.state).toBe('playing');
    expect(player.snapshot.error).toBeNull();
    // The seek was dispatched to the engine; the origin failed it, not the adapter.
    expect(plugin.controls.some(control => control.action === 'seek' && control.value === 90)).toBe(true);
    await player.stop();
  });

  it('closes the native session when the player stops', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod' });
    const sessionKey = plugin.openedPayloads[0]!.sessionKey as string;

    await player.stop();

    expect(plugin.closedKeys).toEqual([sessionKey]);
  });

  it('opens paused at a start position and honors managed timeline offsets', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({
      url: 'https://backend.example/media/managed.mp4',
      kind: 'vod',
      paused: true,
      startAtSeconds: 30,
      timelineOffsetSeconds: 25,
      timelineDurationSeconds: 100,
    });

    // The engine opens at the requested position (its start property)
    // instead of playing from zero and seeking afterwards.
    expect(plugin.openedPayloads[0]).toMatchObject({ autoplay: false, volume: 1, startAtSeconds: 30 });
    expect(last(plugin.controls)).toMatchObject({ action: 'seek', value: 30 });
    expect(player.snapshot.state).toBe('paused');
    expect(player.snapshot.time.positionSeconds).toBe(55);
    // A managed delivery is a rolling window: the server total stays authoritative.
    expect(player.snapshot.time.durationSeconds).toBe(100);

    await player.seek(55);
    expect(last(plugin.controls)).toMatchObject({ action: 'seek', value: 30 });
    await player.stop();
  });

  it('sends engine request properties for authorized sources', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({
      url: 'https://backend.example/media/protected.mp4',
      kind: 'vod',
      authorization: { cookie: 'session=signed', userAgent: 'VIPTV/1' },
    });

    expect(plugin.openedPayloads[0]).toMatchObject({ cookies: 'session=signed', userAgent: 'VIPTV/1' });
    await player.stop();
  });

  it('reports the hls transport for playlist deliveries', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/rolling.m3u8', kind: 'vod' });

    expect(player.snapshot.diagnostics?.transport).toBe('hls');
    await player.stop();
  });

  it('fails honestly when the native protocol does not match', async () => {
    const plugin = new FakeTauriVideoPlugin();
    plugin.diagnostics = { ...plugin.diagnostics, protocolVersion: 2 };
    const { player } = createAdapter(plugin);

    await expect(player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod' }))
      .rejects.toMatchObject({ code: 'engine-unavailable' });
    expect(player.snapshot.state).toBe('error');
    // A session that never established must not keep a native engine attached.
    expect(plugin.closedKeys).toHaveLength(1);
  });

  it('maps an open pipeline failure to an unsupported format for delivery escalation', async () => {
    const plugin = new FakeTauriVideoPlugin();
    // A persistent pipeline failure: the bounded retry re-opens the same
    // delivery once before the failure reaches the delivery escalation.
    plugin.openError = { code: 'PIPELINE_FAILED', message: 'no decoder for the selected stream' };
    const { player } = createAdapter(plugin);

    await expect(player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod' }))
      .rejects.toMatchObject({ code: 'unsupported-format' });
    expect(player.snapshot.error?.message).toBe('no decoder for the selected stream');
    expect(plugin.openedPayloads).toHaveLength(2);
    // Both attempts release their engine state: the retry's release and the
    // failed session's own close.
    expect(plugin.closedKeys).toHaveLength(2);
  });

  it('retries the same delivery once when the engine pipeline fails at open', async () => {
    const plugin = new FakeTauriVideoPlugin();
    // The provider truncated its first response; the fresh engine session
    // receives the whole file.
    plugin.openErrorQueue = [{ code: 'PIPELINE_FAILED', message: "Stream doesn't contain enough data" }];
    const { player } = createAdapter(plugin);

    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod' });

    // The exact same request opened twice.
    expect(plugin.openedPayloads).toHaveLength(2);
    expect(plugin.openedPayloads[1]).toEqual(plugin.openedPayloads[0]);
    // The failed attempt's engine state was released before the retry.
    expect(plugin.closedKeys).toEqual([plugin.openedPayloads[0].sessionKey]);
    expect(player.snapshot.state).toBe('playing');
    await player.stop();
  });

  it('does not retry open failures that are not pipeline failures', async () => {
    const plugin = new FakeTauriVideoPlugin();
    plugin.openError = { code: 'INVALID_REQUEST', message: 'the engine rejected the payload' };
    const { player } = createAdapter(plugin);

    await expect(player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod' }))
      .rejects.toMatchObject({ code: 'prepare-failed' });
    expect(plugin.openedPayloads).toHaveLength(1);
  });

  it('resolves the requested engine against the compiled engines', async () => {
    const url = 'https://backend.example/media/direct.mp4';
    // An explicit engine passes straight through, even against auto's order.
    const explicit = new FakeTauriVideoPlugin();
    explicit.diagnostics = { ...explicit.diagnostics, engines: ['mpv', 'gstreamer'] };
    const explicitPlayer = createAdapter(explicit, { engine: 'gstreamer' }).player;
    await explicitPlayer.open({ url, kind: 'vod' });
    expect(explicit.openedPayloads[0].backend).toBe('gstreamer');
    await explicitPlayer.stop();

    // 'auto' follows the plugin's documented preference order.
    const auto = new FakeTauriVideoPlugin();
    auto.diagnostics = { ...auto.diagnostics, engines: ['mpv', 'gstreamer'] };
    const autoPlayer = createAdapter(auto).player;
    await autoPlayer.open({ url, kind: 'vod' });
    expect(auto.openedPayloads[0].backend).toBe('mpv');
    await autoPlayer.stop();

    // An engine the build did not compile is not requested at all, so a
    // stale persisted choice cannot fail every open.
    const stale = new FakeTauriVideoPlugin();
    stale.diagnostics = { ...stale.diagnostics, engines: ['gstreamer'] };
    const stalePlayer = createAdapter(stale, { engine: 'mpv' }).player;
    await stalePlayer.open({ url, kind: 'vod' });
    expect('backend' in stale.openedPayloads[0]).toBe(false);
    await stalePlayer.stop();

    // A plugin that predates the engines report keeps the engine default.
    const legacy = new FakeTauriVideoPlugin();
    const legacyPlayer = createAdapter(legacy).player;
    await legacyPlayer.open({ url, kind: 'vod' });
    expect('backend' in legacy.openedPayloads[0]).toBe(false);
    await legacyPlayer.stop();
  });

  it('reports the running engine backend in diagnostics', async () => {
    const plugin = new FakeTauriVideoPlugin();
    plugin.openSnapshot = baseSnapshot({ playing: true, backend: 'mpv' });
    const { player } = createAdapter(plugin);

    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod' });

    expect(player.snapshot.diagnostics?.backend).toBe('mpv');
    await player.stop();
  });


  it('maps a seek failure honestly', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod' });
    plugin.controlError = new Error('engine is gone');

    await expect(player.seek(10)).rejects.toMatchObject({ code: 'seek-failed' });
    expect(player.snapshot.state).toBe('error');
    await player.stop();
  });

  it('drives ended and paused states from native stats polling', async () => {
    vi.useFakeTimers();
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod' });

    plugin.statsSnapshot = baseSnapshot({ playing: false, currentTimeSeconds: 600 });
    await vi.advanceTimersByTimeAsync(1);
    expect(player.snapshot.state).toBe('ended');
    expect(player.snapshot.time.positionSeconds).toBe(600);
    await player.stop();
  });

  it('fails the session when stats polling reports a runtime failure', async () => {
    vi.useFakeTimers();
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod' });

    plugin.statsError = { code: 'RUNTIME_UNAVAILABLE', message: 'GStreamer is unavailable' };
    await vi.advanceTimersByTimeAsync(1);
    expect(player.snapshot.state).toBe('error');
    expect(player.snapshot.error?.code).toBe('engine-unavailable');
    await player.stop();
  });

  it('live deliveries report no duration and refuse VOD seeking', async () => {
    const plugin = new FakeTauriVideoPlugin();
    plugin.openSnapshot = baseSnapshot({
      live: true,
      durationSeconds: 0,
      seekableEndSeconds: undefined,
      bufferedSeconds: 12,
      currentTimeSeconds: 5,
      playing: true,
    });
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/live.m3u8', kind: 'live' });

    expect(player.snapshot.kind).toBe('live');
    expect(player.snapshot.time.durationSeconds).toBeNull();
    expect(player.snapshot.time.bufferedEndSeconds).toBeNull();
    await expect(player.seek(30)).rejects.toMatchObject({ code: 'unsupported-operation' });
    await player.stop();
  });

  it('a superseded open closes the old native session', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/first.mp4', kind: 'vod' });
    const firstKey = plugin.openedPayloads[0].sessionKey as string;
    await player.open({ url: 'https://backend.example/media/second.mp4', kind: 'vod' });

    expect(plugin.closedKeys).toEqual([firstKey]);
    expect(player.snapshot.sessionId).toBe(2);
    expect(player.snapshot.state).toBe('playing');
    await player.stop();
    expect(plugin.closedKeys).toEqual([firstKey, plugin.openedPayloads[1].sessionKey]);
  });

  it('forwards anchor layout changes to the native surface', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const anchor = document.createElement('video');
    let rect = { left: 0, top: 0, width: 1280, height: 720 };
    anchor.getBoundingClientRect = () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    } as DOMRect);
    const player = new TauriNativeAdapter(anchor, plugin, { platform: 'linux' });
    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod' });
    expect(plugin.layouts).toHaveLength(0);

    rect = { left: 10, top: 20, width: 640, height: 360 };
    window.dispatchEvent(new Event('resize'));
    await new Promise(resolve => setTimeout(resolve, 40));

    expect(plugin.layouts[0]).toMatchObject({ x: 10, y: 20, width: 640, height: 360 });
    expect(document.documentElement.style.getPropertyValue('--tauri-native-video-left')).toBe('10px');
    await player.stop();
    expect(document.documentElement.style.getPropertyValue('--tauri-native-video-left')).toBe('');
  });
});

describe('Tauri player registration', () => {
  it('registers the native adapter only inside the Tauri runtime', () => {
    const anchor = document.createElement('video');
    expect(() => createPlayer({ platform: 'tauri', video: anchor }))
      .toThrow(/unavailable outside the desktop app/);

    const scoped = window as typeof window & { __TAURI_INTERNALS__?: unknown };
    scoped.__TAURI_INTERNALS__ = {};
    try {
      const player = createPlayer({ platform: 'tauri', video: anchor });
      expect(player.capabilities.platform).toBe('tauri');
      expect(player.capabilities.engine).toContain('tauri-plugin-video');
    } finally {
      delete scoped.__TAURI_INTERNALS__;
    }
  });

  it('keeps the browser engine unchanged outside Tauri', () => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const player = createPlayer({ platform: 'html5', video, canvas });
    expect(player.capabilities.platform).toBe('html5');
  });
});

describe('TAURI_NATIVE_DELIVERY_CAPABILITIES', () => {
  it('declares a broad direct-delivery profile that never asks for transcoding', () => {
    expect(TAURI_NATIVE_DELIVERY_CAPABILITIES).toMatchObject({
      maxWidth: 3840,
      maxHeight: 2160,
      h264: true,
      hevc: true,
      aac: true,
      hevcSdr: true,
      directPlay: true,
      directMp4: true,
      directHls: true,
      directFiles: true,
      directUrls: true,
    });
    expect(TAURI_NATIVE_DELIVERY_CAPABILITIES.directVideoCodecs)
      .toEqual(expect.arrayContaining(['avc', 'hevc', 'vp9', 'av1']));
    expect(TAURI_NATIVE_DELIVERY_CAPABILITIES.directAudioCodecs)
      .toEqual(expect.arrayContaining(['aac', 'ac3', 'eac3', 'dts', 'opus', 'flac']));
  });
});
