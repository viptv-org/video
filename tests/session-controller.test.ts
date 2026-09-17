import { describe, expect, it, vi } from 'vitest';

import { PlayerOperationError, type PlaybackCapabilities, type PlaybackSessionView } from '../src/types';
import { PlaybackSessionController } from '../src/session';
import type { OpenPlayerRequest, Player, PlayerCapabilities, PlayerListener, PlayerSnapshot } from '../src';

/** Mirrors the application API client's refusal error: an Error with a status. */
class TvApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const capabilities: PlaybackCapabilities = { maxWidth: 1920, maxHeight: 1080, h264: true, hevc: false, aac: true, directPlay: true, hevcSdr: false };
const playerCapabilities: PlayerCapabilities = { platform: 'html5', engine: 'fake', directNative: 'supported', adaptiveStreaming: 'probe-required', drm: 'unsupported', canPause: true, canSeek: true, canSelectAudioTrack: false, canSelectTextTrack: false, canDisableTextTrack: false, canUseCookies: false, canUseUserAgent: false, limitations: [] };
const item = { id: 'movie-1', type: 'movie', name: 'Movie', title: 'Movie', genres: [], episodes: [], raw: {}, sourceAddonId: 'addon-a', sourceFingerprint: 'fingerprint-a' };
const source = { id: 'stream-a', name: 'Source A', sourceAddonId: 'addon-a', raw: { source_fingerprint: 'fingerprint-a' } };

class FakePlayer implements Player {
  readonly capabilities = playerCapabilities;
  snapshot: PlayerSnapshot = { sessionId: 0, state: 'idle', kind: null, time: { positionSeconds: 0, durationSeconds: 100 }, tracks: { audio: [], text: [], selectedAudioId: null, selectedTextId: null }, error: null };
  readonly opened: OpenPlayerRequest[] = [];
  failUrl: string | undefined;
  failError: PlayerOperationError | undefined;
  private listeners = new Set<PlayerListener>();
  async open(request: OpenPlayerRequest) {
    this.opened.push(request);
    if (request.url === this.failUrl) throw this.failError ?? new Error('candidate cannot play');
    this.snapshot = { ...this.snapshot, sessionId: this.snapshot.sessionId + 1, state: request.paused ? 'paused' : 'playing', kind: request.kind, time: { positionSeconds: request.timelineOffsetSeconds ?? request.startAtSeconds ?? 0, durationSeconds: 100 } };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }
  async play() { this.snapshot = { ...this.snapshot, state: 'playing' }; }
  async pause() { this.snapshot = { ...this.snapshot, state: 'paused' }; }
  async seek(position: number) { this.snapshot = { ...this.snapshot, time: { ...this.snapshot.time, positionSeconds: position } }; }
  async stop() { this.snapshot = { ...this.snapshot, state: 'stopped' }; }
  async dispose() { await this.stop(); }
  async selectAudioTrack() { throw new Error('unsupported'); }
  async selectTextTrack() { throw new Error('unsupported'); }
  subscribe(listener: PlayerListener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

function session(id: string, url: string, mode = 'managed', position = 0): PlaybackSessionView {
  return { id, url, headers: {}, format: 'mp4', mode, videoMode: 'copy', audioMode: 'copy', position, live: false, duration: 100, audioTracks: [], subtitleTracks: [], subtitlesSupported: false };
}

describe('PlaybackSessionController', () => {
  it('escalates a delivery refusal through managed output and a forced transcode', async () => {
    const player = new FakePlayer();
    const backend = {
      startPlayback: vi.fn()
        .mockRejectedValueOnce(new TvApiError(406, 'Playback could not start; try forced transcoding or another stream'))
        .mockRejectedValueOnce(new TvApiError(406, 'Playback could not start; try forced transcoding or another stream'))
        .mockResolvedValueOnce(session('transcoded', '/index.m3u8', 'managed')),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    const active = await controller.start({ item, source });
    expect(backend.startPlayback).toHaveBeenCalledTimes(3);
    expect(backend.startPlayback).toHaveBeenNthCalledWith(2, expect.objectContaining({ managedOnly: true }));
    expect(backend.startPlayback).toHaveBeenNthCalledWith(3, expect.objectContaining({ managedOnly: true, forceTranscode: true }));
    expect(active.session.id).toBe('transcoded');
  });
  it('escalates a network failure to managed delivery', async () => {
    const player = new FakePlayer();
    const backend = {
      startPlayback: vi.fn()
        .mockRejectedValueOnce(new TvApiError(0, 'Network request failed'))
        .mockResolvedValueOnce(session('managed', '/index.m3u8', 'managed')),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    const active = await controller.start({ item, source });
    expect(backend.startPlayback).toHaveBeenCalledTimes(2);
    expect(backend.startPlayback).toHaveBeenNthCalledWith(2, expect.objectContaining({ managedOnly: true }));
    expect(active.session.id).toBe('managed');
  });
  it('stops escalating after two delivery refusals and surfaces the server answer', async () => {
    const player = new FakePlayer();
    const backend = {
      startPlayback: vi.fn().mockRejectedValue(new TvApiError(406, 'Playback could not start; try forced transcoding or another stream')),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    await expect(controller.start({ item, source })).rejects.toMatchObject({ status: 406 });
    expect(backend.startPlayback).toHaveBeenCalledTimes(3);
    expect(backend.startPlayback).toHaveBeenNthCalledWith(3, expect.objectContaining({ managedOnly: true, forceTranscode: true }));
  });
  it('never retries a validation, authorization, or capacity refusal as a delivery problem', async () => {
    for (const status of [400, 401, 403, 404, 409, 429]) {
      const player = new FakePlayer();
      const backend = {
        startPlayback: vi.fn().mockRejectedValue(new TvApiError(status, 'refused')),
        stopPlayback: vi.fn().mockResolvedValue(undefined),
      };
      const controller = new PlaybackSessionController({ player, backend, capabilities });
      await expect(controller.start({ item, source })).rejects.toMatchObject({ status });
      expect(backend.startPlayback).toHaveBeenCalledTimes(1);
    }
  });

  it('recovers a late direct decoder error at the absolute paused position and ignores stale errors', async () => {
    const player = new FakePlayer();
    const backend = {
      startPlayback: vi.fn().mockResolvedValueOnce(session('direct', '/source.mp4', 'direct'))
        .mockResolvedValueOnce(session('managed', '/index.m3u8', 'managed', 42))
        .mockResolvedValueOnce({ ...session('transcoded', '/transcoded.m3u8', 'managed', 42), videoMode: 'encode' as const }),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    await controller.start({ item, source });
    player.snapshot = { ...player.snapshot, state: 'paused', time: { positionSeconds: 42, durationSeconds: 100 } };
    await controller.recoverPlayback(player.snapshot);
    player.snapshot = { ...player.snapshot, state: 'error', error: { code: 'unsupported-format', message: 'DEMUXER_ERROR_COULD_NOT_PARSE' } };
    const failedSnapshot = player.snapshot;
    expect(await controller.recoverPlayback(failedSnapshot)).toBe(true);
    expect(backend.startPlayback).toHaveBeenNthCalledWith(2, { streamId: source.id, position: 42, capabilities, managedOnly: true });
    expect(player.opened[1]).toMatchObject({ paused: true, startAtSeconds: 0, timelineOffsetSeconds: 42 });
    expect(backend.stopPlayback).toHaveBeenCalledWith('direct');
    expect(await controller.recoverPlayback(failedSnapshot)).toBe(true);
    expect(backend.startPlayback).toHaveBeenCalledTimes(2);
    player.snapshot = { ...player.snapshot, state: 'error', error: failedSnapshot.error };
    expect(await controller.recoverPlayback(player.snapshot)).toBe(true);
    expect(backend.startPlayback).toHaveBeenNthCalledWith(3, {
      streamId: source.id, position: 42, capabilities, managedOnly: true, forceTranscode: true,
    });
  });
  it('never escalates a direct-URL client to managed delivery on a delivery refusal', async () => {
    const player = new FakePlayer();
    const backend = {
      startPlayback: vi.fn().mockRejectedValue(new TvApiError(406, 'Playback could not start; try forced transcoding or another stream')),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities: { ...capabilities, directUrls: true } });
    await expect(controller.start({ item, source })).rejects.toMatchObject({ status: 406 });
    expect(backend.startPlayback).toHaveBeenCalledTimes(1);
  });

  it('never escalates a direct-URL client to managed delivery on an unsupported-format open failure', async () => {
    const player = new FakePlayer();
    player.failUrl = '/media/s/cap/source.mp4';
    player.failError = new PlayerOperationError('unsupported-format', 'the native engine could not demux this source');
    const backend = {
      startPlayback: vi.fn().mockResolvedValue(session('direct', '/media/s/cap/source.mp4', 'direct')),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities: { ...capabilities, directUrls: true } });
    await expect(controller.start({ item, source })).rejects.toMatchObject({ code: 'unsupported-format' });
    expect(backend.startPlayback).toHaveBeenCalledTimes(1);
    expect(backend.stopPlayback).toHaveBeenCalledWith('direct');
  });

  it('never recovers a direct-URL client into managed delivery after a late decoder failure', async () => {
    const player = new FakePlayer();
    const backend = {
      startPlayback: vi.fn().mockResolvedValue(session('direct', '/media/s/cap/source.mp4', 'direct')),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities: { ...capabilities, directUrls: true } });
    await controller.start({ item, source });
    player.snapshot = { ...player.snapshot, state: 'error', error: { code: 'unsupported-format', message: 'DEMUXER_ERROR_COULD_NOT_PARSE' } };
    expect(await controller.recoverPlayback(player.snapshot)).toBe(false);
    expect(backend.startPlayback).toHaveBeenCalledTimes(1);
  });

  it('carries a direct-URL session source authorization into the open request', async () => {
    const player = new FakePlayer();
    const backend = {
      startPlayback: vi.fn().mockResolvedValue({
        ...session('direct', 'https://provider.test/stream.mkv', 'direct'),
        authorization: { cookie: 'provider-session=1', userAgent: 'VIPTV Desktop' },
      }),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities: { ...capabilities, directUrls: true } });
    await controller.start({ item, source });
    expect(player.opened[0].authorization).toEqual({ cookie: 'provider-session=1', userAgent: 'VIPTV Desktop' });
  });


it('coalesces rapid managed seeks so a superseded replacement never holds provider capacity', async () => {
    const player = new FakePlayer();
    // Each managed session holds a provider connection permit. A seek that is
    // superseded before it starts must release its session immediately, or a
    // burst of presses exhausts the provider budget and the server answers 429.
    let deliver!: (value: PlaybackSessionView) => void;
    const backend = {
      startPlayback: vi.fn()
        .mockResolvedValueOnce(session('first', '/index.m3u8', 'managed'))
        // The first seek's replacement stays in flight while a second arrives.
        .mockImplementationOnce(() => new Promise<PlaybackSessionView>((resolve) => { deliver = resolve; }))
        .mockResolvedValueOnce(session('second', '/index.m3u8', 'managed', 60)),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    await controller.start({ item, source });

    const supersededSeek = controller.seekFrom(() => 30, () => 0);
    const currentSeek = controller.seekFrom(() => 60, () => 0);
    // The first replacement finishes after the second one took ownership.
    deliver(session('abandoned', '/abandoned.m3u8', 'managed', 30));

    // A superseded seek resolves (yielding the current owner internally) rather
    // than throwing, so the UI never surfaces an error for a replaced press.
    await expect(supersededSeek).resolves.toBeUndefined();
    await currentSeek;
    // The abandoned session is released instead of being left holding capacity.
    expect(backend.stopPlayback).toHaveBeenCalledWith('abandoned');
    expect(controller.snapshot.active?.session.id).toBe('second');
    // The stale replacement never replaced the live session on the device.
    expect(player.opened.map((request) => request.url)).toEqual(['/index.m3u8', '/index.m3u8']);
  });

  it('a seek that stays current still replaces the session and restores the live position', async () => {
    const player = new FakePlayer();
    const backend = {
      startPlayback: vi.fn().mockResolvedValueOnce(session('first', '/index.m3u8', 'managed'))
        .mockResolvedValueOnce(session('second', '/index.m3u8', 'managed', 30)),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    await controller.start({ item, source });
    player.snapshot = { ...player.snapshot, state: 'paused', time: { positionSeconds: 12, durationSeconds: 100 } };
    await controller.seekFrom(() => 30, () => player.snapshot.time.positionSeconds);
    expect(backend.startPlayback).toHaveBeenNthCalledWith(2, { streamId: source.id, position: 30, capabilities });
    // The replacement opened at the delivery offset and resumed paused.
    expect(player.opened[1]).toMatchObject({ paused: true, startAtSeconds: 0, timelineOffsetSeconds: 30 });
    expect(backend.stopPlayback).toHaveBeenCalledWith('first');
    expect(controller.snapshot.active?.session.id).toBe('second');
  });

  it('seeks a direct session in place without creating a replacement session', async () => {
    const player = new FakePlayer();
    const backend = {
      startPlayback: vi.fn().mockResolvedValueOnce(session('direct', '/source.mp4', 'direct')),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    await controller.start({ item, source });
    await controller.seekFrom(() => 45, () => 0);
    expect(backend.startPlayback).toHaveBeenCalledTimes(1);
    expect(player.snapshot.time.positionSeconds).toBe(45);
  });

  it('does not reopen playback after Stop cancels late live recovery', async () => {
    const player = new FakePlayer();
    let deliver!: (value: PlaybackSessionView) => void;
    const backend = {
      startPlayback: vi.fn().mockResolvedValueOnce(session('direct', '/source.mp4', 'direct'))
        .mockImplementationOnce(() => new Promise<PlaybackSessionView>((resolve) => { deliver = resolve; })),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    await controller.start({ item: { ...item, type: 'live' } });
    player.snapshot = { ...player.snapshot, state: 'error', error: { code: 'unsupported-format', message: 'Cannot parse' } };
    const pending = controller.recoverPlayback(player.snapshot);
    expect(await controller.recoverPlayback(player.snapshot)).toBe(true);
    await controller.stop();
    deliver(session('managed', '/index.m3u8'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(backend.startPlayback).toHaveBeenCalledTimes(2);
    expect(backend.stopPlayback).toHaveBeenCalledWith('managed');
    expect(player.opened).toHaveLength(1);
    expect(controller.snapshot.state).toBe('stopped');
  });

  it('retries a rejected direct container once with managed delivery for the exact source and position', async () => {
    const player = new FakePlayer();
    vi.spyOn(player, 'open').mockRejectedValueOnce(new PlayerOperationError('unsupported-format', 'Cannot parse media'));
    const backend = {
      startPlayback: vi.fn().mockResolvedValueOnce(session('direct', '/direct.mp4', 'direct'))
        .mockResolvedValueOnce(session('managed', '/index.m3u8', 'managed', 25)),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    const active = await controller.start({ item, source, position: 25 });
    expect(backend.startPlayback).toHaveBeenNthCalledWith(2, {
      streamId: source.id, position: 25, capabilities, managedOnly: true,
    });
    expect(backend.stopPlayback).toHaveBeenCalledWith('direct');
    expect(backend.stopPlayback).not.toHaveBeenCalledWith('managed');
    expect(active.session.id).toBe('managed');
  });

  it('uses full transcode only after direct and managed delivery cannot decode', async () => {
    const player = new FakePlayer();
    vi.spyOn(player, 'open')
      .mockRejectedValueOnce(new PlayerOperationError('unsupported-format', 'Cannot parse direct media'))
      .mockRejectedValueOnce(new PlayerOperationError('unsupported-format', 'Cannot parse remuxed media'));
    const backend = {
      startPlayback: vi.fn().mockResolvedValueOnce(session('direct', '/direct.mp4', 'direct'))
        .mockResolvedValueOnce(session('managed', '/index.m3u8'))
        .mockResolvedValueOnce({ ...session('transcoded', '/transcoded.m3u8'), videoMode: 'encode' as const }),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    const active = await controller.start({ item: { ...item, type: 'live' } });
    expect(active.session.id).toBe('transcoded');
    expect(backend.startPlayback).toHaveBeenCalledTimes(3);
    expect(backend.startPlayback).toHaveBeenNthCalledWith(2, { channelId: item.id, position: 0, capabilities, managedOnly: true });
    expect(backend.startPlayback).toHaveBeenNthCalledWith(3, { channelId: item.id, position: 0, capabilities, managedOnly: true, forceTranscode: true });
    expect(backend.stopPlayback.mock.calls.map(([id]) => id)).toEqual(['direct', 'managed']);
  });

  it('requires an explicit VOD source and finds Resume only by stable source identity', async () => {
    const player = new FakePlayer();
    const backend = { startPlayback: vi.fn(), stopPlayback: vi.fn() };
    const controller = new PlaybackSessionController({ player, backend, capabilities });

    await expect(controller.start({ item })).rejects.toThrow('explicit source');
    expect(backend.startPlayback).not.toHaveBeenCalled();
  });

  it('keeps the old backend session until a managed seek replacement opens, then restores it after a candidate failure', async () => {
    const player = new FakePlayer();
    const backend = {
      startPlayback: vi.fn()
        .mockResolvedValueOnce(session('old', 'https://media/old', 'managed', 25))
        .mockResolvedValueOnce(session('candidate', 'https://media/candidate', 'managed', 55)),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    await controller.start({ item, source, position: 25 });
    player.failUrl = 'https://media/candidate';

    await expect(controller.seek(55)).rejects.toThrow('candidate cannot play');
    expect(backend.stopPlayback).toHaveBeenCalledWith('candidate');
    expect(backend.stopPlayback).not.toHaveBeenCalledWith('old');
    expect(player.opened.map((request) => request.url)).toEqual(['https://media/old', 'https://media/candidate', 'https://media/old']);
    expect(player.opened[2]).toMatchObject({ paused: false, startAtSeconds: 0, timelineOffsetSeconds: 25 });
  });

  it('cancels a next resolver without touching the outgoing session', async () => {
    const player = new FakePlayer();
    const backend = { startPlayback: vi.fn().mockResolvedValue(session('old', 'https://media/old')), stopPlayback: vi.fn().mockResolvedValue(undefined) };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    await controller.start({ item, source });
    let resolveNext!: (value: { item: typeof item; source: typeof source } | null) => void;
    const pending = controller.prepareNext(() => new Promise((resolve) => { resolveNext = resolve; }));
    controller.cancelNext();
    resolveNext({ item: { ...item, id: 'episode-2', type: 'series' }, source });
    await pending;

    expect(backend.startPlayback).toHaveBeenCalledTimes(1);
    expect(player.opened).toHaveLength(1);
    expect(controller.snapshot.state).toBe('playing');
  });

  it('does not reopen the outgoing session after stop invalidates an opened next candidate', async () => {
    const player = new FakePlayer();
    const backend = {
      startPlayback: vi.fn()
        .mockResolvedValueOnce(session('old', 'https://media/old'))
        .mockResolvedValueOnce(session('next', 'https://media/next')),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    await controller.start({ item, source });

    let releaseCandidate!: () => void;
    let markCandidateOpened!: () => void;
    const candidateOpened = new Promise<void>((resolve) => { releaseCandidate = resolve; });
    const candidateWasOpened = new Promise<void>((resolve) => { markCandidateOpened = resolve; });
    vi.spyOn(player, 'open').mockImplementation(async (request) => {
      player.opened.push(request);
      if (request.url === 'https://media/next') {
        markCandidateOpened();
        await candidateOpened;
      }
    });

    const pending = controller.prepareNext(async () => ({ item: { ...item, id: 'episode-2', type: 'series' }, source }));
    await candidateWasOpened;
    const stopping = controller.stop();
    releaseCandidate();
    await Promise.all([pending, stopping]);

    expect(player.opened.map((request) => request.url)).toEqual(['https://media/old', 'https://media/next']);
    expect(controller.snapshot).toMatchObject({ state: 'stopped', active: null });
  });

  it('restores the outgoing session when Back cancels after the next candidate opened', async () => {
    const player = new FakePlayer();
    const backend = {
      startPlayback: vi.fn()
        .mockResolvedValueOnce(session('old', 'https://media/old'))
        .mockResolvedValueOnce(session('next', 'https://media/next')),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    await controller.start({ item, source });

    let releaseCandidate!: () => void;
    let markCandidateOpened!: () => void;
    const candidateOpened = new Promise<void>((resolve) => { releaseCandidate = resolve; });
    const candidateWasOpened = new Promise<void>((resolve) => { markCandidateOpened = resolve; });
    vi.spyOn(player, 'open').mockImplementation(async (request) => {
      player.opened.push(request);
      if (request.url === 'https://media/next') {
        markCandidateOpened();
        await candidateOpened;
      }
    });

    const pending = controller.prepareNext(async () => ({ item: { ...item, id: 'episode-2', type: 'series' }, source }));
    await candidateWasOpened;
    controller.cancelNext();
    releaseCandidate();
    await pending;

    expect(player.opened.map((request) => request.url)).toEqual(['https://media/old', 'https://media/next', 'https://media/old']);
    expect(controller.snapshot.active?.session.id).toBe('old');
  });

  it('carries selected managed tracks and paused intent through a later managed seek', async () => {
    const player = new FakePlayer();
    const backend = {
      startPlayback: vi.fn()
        .mockResolvedValueOnce(session('old', 'https://media/old', 'managed', 25))
        .mockResolvedValueOnce(session('tracks', 'https://media/tracks', 'managed', 25))
        .mockResolvedValueOnce(session('seek', 'https://media/seek', 'managed', 55)),
      stopPlayback: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new PlaybackSessionController({ player, backend, capabilities });
    await controller.start({ item, source, position: 25 });
    await controller.replaceTracks({ subtitleTrackIndex: 4, subtitlesOff: false });
    await player.pause();
    await controller.seek(55);

    expect(backend.startPlayback).toHaveBeenLastCalledWith(expect.objectContaining({ position: 55, subtitleTrackIndex: 4, subtitlesOff: false }));
    expect(player.opened.at(-1)).toMatchObject({ url: 'https://media/seek', startAtSeconds: 0, timelineOffsetSeconds: 55, paused: true });
  });
});


describe('browser capability preparation', () => {
  it('refuses unsupported playback before creating a backend session', async () => {
    const backend = { startPlayback: vi.fn(), stopPlayback: vi.fn() };
    const controller = new PlaybackSessionController({ player: new FakePlayer(), backend,
      capabilities: async () => { throw new Error('unsupported codecs'); } });
    await expect(controller.start({ item, source })).rejects.toThrow('unsupported codecs');
    expect(backend.startPlayback).not.toHaveBeenCalled();
    expect(controller.snapshot.state).toBe('error');
  });

  it('Back cancels a pending probe before any backend request', async () => {
    let resolve!: (value: PlaybackCapabilities) => void;
    const probe = new Promise<PlaybackCapabilities>((done) => { resolve = done; });
    const backend = { startPlayback: vi.fn(), stopPlayback: vi.fn() };
    const controller = new PlaybackSessionController({ player: new FakePlayer(), backend, capabilities: () => probe });
    const pending = controller.start({ item, source });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await controller.stop();
    resolve(capabilities);
    await rejected;
    expect(backend.startPlayback).not.toHaveBeenCalled();
    expect(controller.snapshot.state).toBe('stopped');
  });
});
