import { afterEach, describe, expect, it, vi } from 'vitest';

import { TAURI_VIDEO_PROTOCOL_VERSION, TauriNativeAdapter } from '../src/tauri-native';
import { nativeOperationError } from '../src/tauri-native/wire';
import { baseSnapshot, createAdapter, FakeTauriVideoPlugin, last } from './tauri-native-fake';

afterEach(() => {
  vi.useRealTimers();
});

describe('TauriNativeAdapter', () => {
  it('coalesces slider drags into one pending command and the latest volume', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/file.mp4', kind: 'vod' });
    const invoke = plugin.invoke.bind(plugin);
    const values: number[] = [];
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(plugin, 'invoke').mockImplementation(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      const payload = args?.payload as { action?: string; value: number } | undefined;
      if (command.endsWith('native_control') && payload?.action === 'volume') {
        values.push(payload.value);
        if (values.length === 1) await pending;
      }
      return invoke<T>(command, args);
    });
    const changes = Array.from({ length: 100 }, (_, index) => player.setVolume((index + 1) / 100));
    expect(player.snapshot.volume?.level).toBe(1);
    const queued = [...values];
    release();
    await Promise.all(changes);
    expect(queued).toEqual([0.01]);
    expect(values).toEqual([0.01, 1]);
    await player.stop();
  });

  it('keeps mute as the latest native value while a slider command is pending', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/file.mp4', kind: 'vod' });
    const invoke = plugin.invoke.bind(plugin);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    vi.spyOn(plugin, 'invoke').mockImplementation(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command.endsWith('native_control') && (args?.payload as { action?: string })?.action === 'volume' && !held) {
        held = true;
        await pending;
      }
      return invoke<T>(command, args);
    });
    const first = player.setVolume(0.5);
    const latest = player.setVolume(0.4);
    const muted = player.setMuted(true);
    expect(player.snapshot.volume).toMatchObject({ level: 0.4, muted: true });
    release();
    await Promise.all([first, latest, muted]);
    expect(plugin.controls.filter(control => control.action === 'volume').map(control => control.value)).toEqual([0.5, 0]);
    await player.stop();
  });

  it('ignores a retired source volume failure without holding the new source slider', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/file.mp4', kind: 'vod' });
    const invoke = plugin.invoke.bind(plugin);
    let reject!: (cause: unknown) => void;
    const pending = new Promise<void>((_, no) => { reject = no; });
    let held = false;
    vi.spyOn(plugin, 'invoke').mockImplementation(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command.endsWith('native_control') && (args?.payload as { action?: string })?.action === 'volume' && !held) {
        held = true;
        await pending;
      }
      return invoke<T>(command, args);
    });
    const retired = player.setVolume(0.2);
    await player.open({ url: 'https://backend.example/other.mp4', kind: 'vod' });
    await player.setVolume(0.7);
    reject({ code: 'INVALID_REQUEST', message: 'Retired session.' });
    await expect(retired).resolves.toBeUndefined();
    expect(player.snapshot.volume?.level).toBe(0.7);
    expect(player.snapshot.error).toBeNull();
    await player.stop();
  });

  it('ignores late successful stats after a terminal startup timeout', async () => {
    vi.useFakeTimers();
    const plugin = new FakeTauriVideoPlugin();
    plugin.openSnapshot = baseSnapshot({ videoWidth: 0, videoHeight: 0 });
    const invoke = plugin.invoke.bind(plugin);
    let release!: (snapshot: ReturnType<typeof baseSnapshot>) => void;
    const pending = new Promise<ReturnType<typeof baseSnapshot>>(resolve => { release = resolve; });
    vi.spyOn(plugin, 'invoke').mockImplementation(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command.endsWith('native_stats')) return await pending as T;
      return invoke<T>(command, args);
    });
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/file.mp4', kind: 'vod' });
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(8000);
    const failure = player.snapshot.error;
    expect(failure?.code).toBe('prepare-failed');
    release(baseSnapshot({ playing: false, currentTimeSeconds: 1 }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(player.snapshot.state).toBe('error');
    expect(player.snapshot.error).toBe(failure);
    await player.stop();
  });

  it('emits a terminal stats error once and stops polling until a new source opens', async () => {
    vi.useFakeTimers();
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/file.mp4', kind: 'vod' });
    const errors: unknown[] = [];
    const off = player.subscribe(snapshot => { if (snapshot.error) errors.push(snapshot.error); });
    plugin.statsError = { code: 'PIPELINE_FAILED', message: 'Native playback failed.' };
    await vi.advanceTimersByTimeAsync(3000);
    expect(errors).toHaveLength(1);
    expect(player.snapshot.error?.code).toBe('prepare-failed');
    const polls = plugin.commands.filter(command => command.endsWith('native_stats')).length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(plugin.commands.filter(command => command.endsWith('native_stats'))).toHaveLength(polls);
    plugin.statsError = undefined;
    await player.open({ url: 'https://backend.example/other.mp4', kind: 'vod' });
    await vi.advanceTimersByTimeAsync(300);
    expect(player.snapshot.error).toBeNull();
    expect(player.snapshot.state).toBe('playing');
    off();
    await player.stop();
  });

  it("returns to playing after pause and resume facts arrive through polling", async () => {
    vi.useFakeTimers();
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: "https://backend.example/file.mp4", kind: "vod" });
    plugin.statsSnapshot = baseSnapshot({ playing: false });
    await vi.advanceTimersByTimeAsync(300);
    expect(player.snapshot.state).toBe("paused");
    plugin.statsSnapshot = baseSnapshot({
      playing: true,
      currentTimeSeconds: 30,
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(player.snapshot.state).toBe("playing");
    expect(player.snapshot.time.positionSeconds).toBe(30);
    await player.stop();
  });

  it("publishes volume immediately while native volume IPC is pending", async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: "https://backend.example/file.mp4", kind: "vod" });
    const invoke = plugin.invoke.bind(plugin);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(plugin, "invoke").mockImplementation(
      async <T>(
        command: string,
        args?: Record<string, unknown>,
      ): Promise<T> => {
        if (
          command === "plugin:video|native_control" &&
          (args?.payload as { action?: string })?.action === "volume"
        )
          await pending;
        return invoke<T>(command, args);
      },
    );
    const changed = player.setVolume(0.37);
    expect(player.snapshot.volume).toMatchObject({ level: 0.37, muted: false });
    release();
    await changed;
    await player.stop();
  });

  it('uses tracks discovered by polling for later native selections', async () => {
    vi.useFakeTimers();
    const plugin = new FakeTauriVideoPlugin();
    plugin.openSnapshot = baseSnapshot({ playing: true, tracks: [] });
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/file.mp4', kind: 'vod' });
    plugin.statsSnapshot = baseSnapshot({ playing: true });
    await vi.advanceTimersByTimeAsync(300);
    await player.selectAudioTrack('audio:1');
    expect(last(plugin.controls)).toMatchObject({ action: 'track', index: 1 });
    await player.selectTextTrack('text:2');
    expect(last(plugin.controls)).toMatchObject({ action: 'track', index: 2 });
    await player.stop();
  });

  it('keeps playback active when a track command is refused', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/file.mp4', kind: 'vod' });
    plugin.controlError = { code: 'PIPELINE_FAILED', message: 'Decoder rejected track selection.' };
    await expect(player.selectAudioTrack('audio:1')).rejects.toMatchObject({ code: 'unsupported-operation' });
    expect(player.snapshot.state).toBe('playing');
    expect(player.snapshot.error).toBeNull();
    await player.stop();
  });

  it('preserves typed native source failures instead of treating them all as decode refusals', () => {
    for (const [wire, expected] of [
      ['AUTHORIZATION_FAILED', 'authorization-failed'],
      ['CONNECTION_FAILED', 'connection-failed'],
      ['SOURCE_UNAVAILABLE', 'expired-source'],
      ['PIPELINE_FAILED', 'prepare-failed'],
      ['DECODE_FAILED', 'unsupported-format'],
      ['MEDIA_FORMAT_FAILED', 'unsupported-format'],
      ['VIDEO_OUTPUT_FAILED', 'engine-unavailable'],
      ['AUDIO_OUTPUT_FAILED', 'engine-unavailable'],
      ['PROTECTED_MEDIA', 'authorization-unsupported'],
    ]) {
      expect(nativeOperationError({ code: wire, message: 'Safe source failure.' }, 'unsupported-format', 'Fallback')).toMatchObject({ code: expected });
    }
  });

  it('does not repeat a misleading decoder message from an older plugin pipeline error', () => {
    expect(nativeOperationError({ code: 'PIPELINE_FAILED', message: 'The native player could not decode this media delivery.' },
      'connection-failed', 'Native playback stopped unexpectedly.')).toMatchObject({
      code: 'prepare-failed', message: 'Native playback stopped unexpectedly.',
    });
  });

  it('rejects invalid source headers before replacing the active native session', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod' });
    await expect(player.open({ url: 'https://backend.example/media/other.mp4', kind: 'vod', authorization: { headers: { Authorization: 'secret\r\nInjected: yes' } } })).rejects.toMatchObject({ code: 'authorization-failed' });
    expect(plugin.openedPayloads).toHaveLength(1);
    expect(plugin.closedKeys).toHaveLength(0);
    expect(player.snapshot.state).toBe('playing');
    await player.stop();
  });

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

  it('sends native picture modes without opening a new playback and reapplies Fill on source replacement', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod' });
    await player.setPictureMode('fill');
    expect(last(plugin.controls)).toMatchObject({ action: 'crop' });
    expect(plugin.openedPayloads).toHaveLength(1);
    await player.setPictureMode('fit');
    expect(last(plugin.controls)).toMatchObject({ action: 'fit' });
    await player.setPictureMode('fill');
    await player.open({ url: 'https://backend.example/media/other.mp4', kind: 'vod' });
    expect(last(plugin.controls)).toMatchObject({ action: 'crop' });
    await player.stop();
  });

  for (const interrupt of ['stop', 'replacement'] as const) {
    it(`discards an old Fill-open acknowledgment after ${interrupt}`, async () => {
      const plugin = new FakeTauriVideoPlugin();
      const { player } = createAdapter(plugin);
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      const pending = new Promise<void>(resolve => { release = resolve; });
      plugin.cropDelay = { entered, pending };
      await player.setPictureMode('fill');
      const oldOpen = player.open({ url: 'https://backend.example/media/old.mp4', kind: 'vod', startAtSeconds: 30 });
      await reached;
      if (interrupt === 'stop') await player.stop();
      else await player.open({ url: 'https://backend.example/media/new.mp4', kind: 'vod' });
      const key = last(plugin.openedPayloads).sessionKey;
      release();
      await oldOpen;
      expect(plugin.controls.filter(control => control.action === 'seek' && control.sessionKey === key)).toEqual([]);
      expect(player.snapshot.state).toBe(interrupt === 'stop' ? 'stopped' : 'playing');
      expect(player.snapshot.time.positionSeconds).toBe(0);
      await player.stop();
    });
  }

  it('honors a VOD resume target before native duration and live metadata settle', async () => {
    const plugin = new FakeTauriVideoPlugin();
    plugin.openSnapshot = baseSnapshot({ durationSeconds: 0, live: true, playing: true });
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod', startAtSeconds: 30 });
    expect(plugin.controls.filter(control => control.action === 'seek').map(control => control.value)).toEqual([30]);
    expect(player.snapshot.time.positionSeconds).toBe(30);
    await player.stop();
  });

  it('does not seek a live request when initial native metadata reports otherwise', async () => {
    const plugin = new FakeTauriVideoPlugin();
    plugin.openSnapshot = baseSnapshot({ durationSeconds: 0, live: false, playing: true });
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/live.m3u8', kind: 'live', startAtSeconds: 30 });
    expect(plugin.controls.filter(control => control.action === 'seek')).toEqual([]);
    await player.stop();
  });

  it('abandons seek confirmation when the native session stops', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod', startAtSeconds: 30 });
    plugin.seekAcknowledgesAtZero = true;
    const pending = player.seek(90);
    await Promise.resolve();
    await player.stop();
    await pending;
    expect(player.snapshot.state).toBe('stopped');
    expect(player.snapshot.time.positionSeconds).toBe(0);
  });

  it('confirms a flushing seek before interpreting a transient zero acknowledgment as a replay', async () => {
    const plugin = new FakeTauriVideoPlugin();
    const { player } = createAdapter(plugin);
    await player.open({ url: 'https://backend.example/media/direct.mp4', kind: 'vod', startAtSeconds: 30 });
    plugin.seekAcknowledgesAtZero = true;

    await expect(player.seek(90)).resolves.toBeUndefined();
    expect(player.snapshot.time.positionSeconds).toBe(90);
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
      authorization: { cookie: 'session=signed', userAgent: 'VIPTV/1', headers: { Referer: 'https://provider.example/watch', Authorization: 'Bearer source-token', Cookie: 'session=signed' } },
    });

    expect(plugin.openedPayloads[0]).toMatchObject({ cookies: 'session=signed', userAgent: 'VIPTV/1', headers: { Referer: 'https://provider.example/watch', Authorization: 'Bearer source-token' } });
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

  it('maps an explicit decoder failure to an unsupported format for delivery escalation', async () => {
    const plugin = new FakeTauriVideoPlugin();
    // A persistent pipeline failure: the bounded retry re-opens the same
    // delivery once before the failure reaches the delivery escalation.
    plugin.openError = { code: 'DECODE_FAILED', message: 'no decoder for the selected stream' };
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

    // 'auto' follows the plugin's documented preference order: the first
    // compiled engine, which the plugin lists GStreamer-first.
    const auto = new FakeTauriVideoPlugin();
    auto.diagnostics = { ...auto.diagnostics, engines: ['gstreamer', 'mpv'] };
    const autoPlayer = createAdapter(auto).player;
    await autoPlayer.open({ url, kind: 'vod' });
    expect(auto.openedPayloads[0].backend).toBe('gstreamer');
    await autoPlayer.stop();

    // An explicit engine the build did not compile fails with a typed error
    // before native_open; it never silently plays on another engine.
    const stale = new FakeTauriVideoPlugin();
    stale.diagnostics = { ...stale.diagnostics, engines: ['gstreamer'] };
    const stalePlayer = createAdapter(stale, { engine: 'mpv' }).player;
    await expect(stalePlayer.open({ url, kind: 'vod' })).rejects.toMatchObject({ code: 'engine-unavailable' });
    expect(stale.openedPayloads).toHaveLength(0);
    expect(stalePlayer.snapshot.error?.code).toBe('engine-unavailable');
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
    expect(player.snapshot.state).toBe('playing');
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
