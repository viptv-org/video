import { afterEach, describe, expect, it, vi } from 'vitest';

import { TAURI_VIDEO_PROTOCOL_VERSION, TauriNativeAdapter } from '../src/tauri-native';
import { baseSnapshot, createAdapter, FakeTauriVideoPlugin, last } from './tauri-native-fake';

afterEach(() => {
  vi.useRealTimers();
});

describe('TauriNativeAdapter', () => {
  it('verifies the protocol, opens the exact selected source, and reports engine tracks', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player, anchor } = createAdapter(plugin);
    // A direct original-file delivery: only then may the engine raise the duration.
    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod', adoptEngineDuration: true });
    const sessionKey = plugin.openedPayloads[0]!.sessionKey as string;

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
    // The stop closes exactly the session this open established.
    expect(plugin.closedKeys).toEqual([sessionKey]);
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
