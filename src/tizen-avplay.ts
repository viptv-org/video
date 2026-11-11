import { SessionPlayer } from './session';
import { checkedSourceAuthorization } from './source-authorization';
import { nonNegative } from './primitives';
import { subtitleIntent } from './subtitle-intent';
import {
  type OpenPlayerRequest,
  type PlayerErrorCode,
  PlayerOperationError,
  boundedPosition,
  growOnlyDuration,
  timelineDuration,
  type PlayerCapabilities,
  type PlayerTrack,
  type PlayerTracks,
} from './types';

export interface AvplayTrackInfo {
  readonly index: number;
  readonly type: 'VIDEO' | 'AUDIO' | 'TEXT';
  readonly extra_info: string;
}

export interface AvplayListener {
  onbufferingstart?: () => void;
  onbufferingcomplete?: () => void;
  oncurrentplaytime?: (milliseconds: number) => void;
  onstreamcompleted?: () => void;
  onerror?: (error: string) => void;
  onerrormsg?: (error: string, message: string) => void;
}

/** The small, injectable subset of Samsung's documented `webapis.avplay`. */
export interface AvplayManager {
  open(url: string): void;
  close(): void;
  prepareAsync(success: () => void, error?: (error: unknown) => void): void;
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(milliseconds: number, success?: () => void, error?: (error: unknown) => void): void;
  getCurrentTime(): number;
  getDuration(): number;
  getTotalTrackInfo(): readonly AvplayTrackInfo[];
  setListener(listener: AvplayListener): void;
  setDisplayRect?(x: number, y: number, width: number, height: number): void;
  setSelectTrack(type: 'AUDIO' | 'TEXT', index: number): void;
  setSilentSubtitle(enabled: boolean): void;
  setStreamingProperty?(property: 'COOKIE' | 'USER_AGENT', value: string): void;
}

export const TIZEN_AVPLAY_CAPABILITIES: PlayerCapabilities = {
  platform: 'tizen',
  engine: 'Samsung AVPlay',
  directNative: 'probe-required',
  adaptiveStreaming: 'probe-required',
  drm: 'probe-required',
  canPause: true,
  canSeek: true,
  canSelectAudioTrack: true,
  canSelectTextTrack: true,
  canDisableTextTrack: true,
  canUseCookies: true,
  canUseUserAgent: true,
  limitations: [
    'Codec, DRM, adaptive and subtitle support vary by TV model and firmware; qualify the exact source on device.',
    'AVPlay TEXT selection is unavailable for DASH according to Samsung documentation.',
    'COOKIE and USER_AGENT are available only when this runtime exposes setStreamingProperty; arbitrary headers are unsupported.',
  ],
};

interface PendingOpen {
  readonly sessionId: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

export class TizenAvplayAdapter extends SessionPlayer {
  readonly capabilities: PlayerCapabilities;
  private pendingOpen: PendingOpen | null = null;
  private pendingSeek: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private timelineOffsetSeconds = 0;
  private timelineDurationSeconds: number | undefined;
  private adoptEngineDuration = false;
  private observedTitleDuration: number | null = null;
  private subtitleRequest?: OpenPlayerRequest;
  private pauseRequested = false;
  private bufferingPosition: number | undefined;

  constructor(private readonly avplay: AvplayManager = resolveAvplay()) {
    super();
    // Older/model-specific runtimes can expose AVPlay without the authorization
    // property API. Advertise only what this injected runtime can actually set.
    this.capabilities = {
      ...TIZEN_AVPLAY_CAPABILITIES,
      canUseCookies: Boolean(avplay.setStreamingProperty),
      canUseUserAgent: Boolean(avplay.setStreamingProperty),
    };
  }

  open(request: OpenPlayerRequest): Promise<void> {
    this.lifecycleGeneration += 1;
    this.cancelPendingOpen();
    this.invalidateSession();
    const sessionId = this.startSession(request.kind);
    this.timelineOffsetSeconds = nonNegative(request.timelineOffsetSeconds ?? 0);
    this.timelineDurationSeconds = request.timelineDurationSeconds;
    this.adoptEngineDuration = request.adoptEngineDuration === true;
    this.observedTitleDuration = null;
    this.subtitleRequest = request;
    this.pauseRequested = request.paused === true;

    return new Promise<void>((resolve, reject) => {
      this.pendingOpen = { sessionId, resolve, reject };
      void this.afterSeek(() => {
        this.closeSafely();
        try {
          this.avplay.open(request.url);
          this.avplay.setListener(this.listenerFor(sessionId));
          this.setDisplayRect();
          // COOKIE/USER_AGENT must be set in IDLE before prepareAsync().
          this.applyAuthorization(request);
          this.avplay.prepareAsync(
            () => this.prepared(sessionId, request),
            (cause) => this.preparationFailed(sessionId, cause),
          );
        } catch (cause) {
          this.preparationFailed(sessionId, cause);
        }
      }, () => this.isCurrent(sessionId)).catch(cause => this.preparationFailed(sessionId, cause));
    });
  }

  async play(): Promise<void> {
    const sessionId = this.activeSessionOrThrow();
    this.pauseRequested = false;
    return this.afterSeek(() => {
      if (this.snapshot.state === 'playing') return;
      try {
        this.avplay.play();
        this.applySubtitleIntent(sessionId);
        this.update(sessionId, { state: 'playing', error: null });
      } catch (cause) {
        this.throwOperation(sessionId, 'invalid-state', 'AVPlay could not resume playback.', cause);
      }
    }, () => this.isCurrent(sessionId));
  }

  async pause(): Promise<void> {
    const sessionId = this.activeSessionOrThrow();
    this.pauseRequested = true;
    return this.afterSeek(() => {
      // A prepared paused open is still READY natively; pause() is invalid there.
      if (this.snapshot.state === 'paused') return;
      try {
        this.avplay.pause();
        this.update(sessionId, { state: 'paused' });
      } catch (cause) {
        this.throwOperation(sessionId, 'invalid-state', 'AVPlay could not pause playback.', cause);
      }
    }, () => this.isCurrent(sessionId));
  }

  seek(positionSeconds: number): Promise<void> {
    const sessionId = this.activeSessionOrThrow();
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
      return Promise.reject(new PlayerOperationError('seek-failed', 'Seek position must be a non-negative number.'));
    }
    return this.afterSeek(() => new Promise<void>((resolve, reject) => {
      const nativePosition = Math.max(0, positionSeconds - this.timelineOffsetSeconds);
      this.nativeSeek(Math.round(nativePosition * 1000), () => {
        if (this.isCurrent(sessionId)) this.updateTimeFromEngine(sessionId, positionSeconds);
        resolve();
      }, (cause) => {
        reject(operationFailure('seek-failed', 'AVPlay could not seek the selected source.', cause));
      });
    }), () => this.isCurrent(sessionId));
  }

  async stop(): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.subtitleRequest = undefined;
    this.cancelPendingOpen();
    this.invalidateSession();
    this.terminal('stopped');
    return this.afterSeek(() => {
      try { this.avplay.stop(); } catch { /* stop is state-dependent on AVPlay */ }
      this.closeSafely();
    }, () => generation === this.lifecycleGeneration);
  }

  async dispose(): Promise<void> {
    const generation = this.lifecycleGeneration + 1;
    await this.stop();
    if (generation === this.lifecycleGeneration) this.terminal('disposed');
  }

  async selectAudioTrack(trackId: string): Promise<void> {
    const sessionId = this.activeSessionOrThrow();
    const track = this.findTrack('audio', trackId);
    if (!track) throw new PlayerOperationError('unsupported-operation', `Audio track ${trackId} is not available.`);
    return this.afterSeek(() => {
      try {
        this.avplay.setSelectTrack('AUDIO', parseTrackIndex(trackId));
        this.update(sessionId, { tracks: { ...this.snapshot.tracks, selectedAudioId: trackId } });
      } catch (cause) {
        this.throwOperation(sessionId, 'unsupported-operation', `AVPlay could not select audio track ${track.label}.`, cause);
      }
    }, () => this.isCurrent(sessionId));
  }

  async selectTextTrack(trackId: string | null): Promise<void> {
    this.subtitleRequest = undefined;
    const sessionId = this.activeSessionOrThrow();
    return this.afterSeek(() => {
      try {
        if (trackId === null) {
          // Samsung defines true as hidden and false as shown.
          this.avplay.setSilentSubtitle(true);
          this.update(sessionId, { tracks: { ...this.snapshot.tracks, selectedTextId: null } });
          return;
        }
        const track = this.findTrack('text', trackId);
        if (!track) throw new PlayerOperationError('unsupported-operation', `Subtitle track ${trackId} is not available.`);
        this.avplay.setSelectTrack('TEXT', parseTrackIndex(trackId));
        this.avplay.setSilentSubtitle(false);
        this.update(sessionId, { tracks: { ...this.snapshot.tracks, selectedTextId: trackId } });
      } catch (cause) {
        if (cause instanceof PlayerOperationError) throw cause;
        this.throwOperation(sessionId, 'unsupported-operation', 'AVPlay could not select subtitles for this source.', cause);
      }
    }, () => this.isCurrent(sessionId));
  }

  private prepared(sessionId: number, request: OpenPlayerRequest): void {
    if (!this.isCurrent(sessionId)) return;
    const startAtSeconds = boundedPosition(request.startAtSeconds ?? 0, this.durationSeconds());
    this.update(sessionId, {
      state: 'ready',
      time: { positionSeconds: this.timelineOffsetSeconds + startAtSeconds, durationSeconds: this.durationSeconds() },
      tracks: tracksFromAvplay(this.avplay.getTotalTrackInfo()),
      error: null,
    });
    const complete = () => {
      if (!this.isCurrent(sessionId)) return;
      if (this.pauseRequested) {
        this.update(sessionId, { state: 'paused' });
      } else {
        try {
          this.avplay.play();
          this.applySubtitleIntent(sessionId);
          this.update(sessionId, { state: 'playing' });
        } catch (cause) {
          this.preparationFailed(sessionId, cause);
          return;
        }
      }
      this.resolvePending(sessionId);
    };
    if (startAtSeconds > 0) {
      this.nativeSeek(Math.round(startAtSeconds * 1000), complete, (cause) => this.preparationFailed(sessionId, cause));
    } else {
      complete();
    }
  }

  private preparationFailed(sessionId: number, cause: unknown): void {
    if (!this.isCurrent(sessionId)) return;
    const error = cause instanceof PlayerOperationError
      ? cause
      : operationFailure('prepare-failed', 'AVPlay could not prepare the selected source.', cause);
    this.fail(sessionId, error.toFailure());
    if (this.pendingOpen?.sessionId === sessionId) {
      this.pendingOpen.reject(error);
      this.pendingOpen = null;
    }
  }

  private listenerFor(sessionId: number): AvplayListener {
    return {
      onbufferingstart: () => {
        if (!this.isCurrent(sessionId) || this.snapshot.state === 'error' || this.pauseRequested) return;
        this.bufferingPosition = undefined;
        this.update(sessionId, { state: 'buffering' });
      },
      onbufferingcomplete: () => {
        if (this.snapshot.state === 'buffering') this.update(sessionId, { state: this.pauseRequested ? 'paused' : 'playing' });
      },
      // AVPlay's documented callback value is the event's timeline fact. Do not
      // replace it with a second engine read that can lag behind the callback.
      oncurrentplaytime: (milliseconds) => {
        if (!this.isCurrent(sessionId)) return;
        try { if (!this.pendingSeek) this.applySubtitleIntent(sessionId); }
        catch (cause) {
          this.fail(sessionId, operationFailure('unsupported-operation', 'AVPlay could not select the requested subtitles.', cause).toFailure());
          return;
        }
        const position = milliseconds / 1000;
        const recovered = this.snapshot.state === 'buffering' && !this.pauseRequested &&
          this.bufferingPosition !== undefined && position > this.bufferingPosition;
        this.bufferingPosition = position;
        this.update(sessionId, {
          ...(recovered ? { state: 'playing' as const } : {}),
          time: { positionSeconds: this.timelineOffsetSeconds + position, durationSeconds: this.durationSeconds() },
        });
      },
      onstreamcompleted: () => this.update(sessionId, { state: 'ended' }),
      onerror: (code) => this.fail(sessionId, operationFailure('connection-failed', `AVPlay error: ${code}`).toFailure()),
      onerrormsg: (code, message) => this.fail(sessionId, operationFailure('connection-failed', `AVPlay error ${code}: ${message}`).toFailure()),
    };
  }

  private updateTimeFromEngine(sessionId: number, fallbackPosition: number): void {
    let nativePositionSeconds = Math.max(0, fallbackPosition - this.timelineOffsetSeconds);
    try { nativePositionSeconds = this.avplay.getCurrentTime() / 1000; } catch { /* requested native position remains useful */ }
    this.update(sessionId, { time: { positionSeconds: this.timelineOffsetSeconds + nativePositionSeconds, durationSeconds: this.durationSeconds() } });
  }

  private durationSeconds(): number | null {
    if (this.pendingSeek) return this.observedTitleDuration;
    let engine: number | null = null;
    try {
      const duration = this.avplay.getDuration() / 1000;
      engine = Number.isFinite(duration) && duration > 0 ? duration + this.timelineOffsetSeconds : null;
    } catch {
      engine = null;
    }
    // A managed delivery is a rolling window; the server total is authoritative
    // and the reported length only ever grows.
    const next = timelineDuration(this.timelineDurationSeconds, engine, this.adoptEngineDuration);
    return (this.observedTitleDuration = growOnlyDuration(this.observedTitleDuration, next));
  }

  private applyAuthorization(request: OpenPlayerRequest): void {
    const authorization = checkedSourceAuthorization(request.authorization);
    if (!authorization) return;
    if (Object.keys(authorization.headers ?? {}).length)
      throw new PlayerOperationError('authorization-unsupported', 'This source requires gateway delivery for its request headers.');
    if (!this.avplay.setStreamingProperty) {
      throw new PlayerOperationError('authorization-unsupported', 'This AVPlay runtime cannot set authorization properties.');
    }
    if (authorization.cookie) this.avplay.setStreamingProperty('COOKIE', authorization.cookie);
    if (authorization.userAgent) this.avplay.setStreamingProperty('USER_AGENT', authorization.userAgent);
  }

  private findTrack(kind: 'audio' | 'text', id: string): PlayerTrack | undefined {
    return this.snapshot.tracks[kind].find((track) => track.id === id && track.available);
  }

  private applySubtitleIntent(sessionId: number): void {
    const request = this.subtitleRequest;
    if (!request || !this.isCurrent(sessionId)) return;
    const tracks = tracksFromAvplay(this.avplay.getTotalTrackInfo());
    const id = subtitleIntent(request, tracks.text);
    if (id === undefined) return;
    this.subtitleRequest = undefined;
    // HLS TEXT selection is allowed in PLAYING/PAUSED, not READY.
    if (id !== null) this.avplay.setSelectTrack('TEXT', parseTrackIndex(id));
    this.avplay.setSilentSubtitle(id === null);
    this.update(sessionId, { tracks: { ...tracks, selectedTextId: id } });
  }

  private throwOperation(sessionId: number, code: PlayerErrorCode, message: string, cause: unknown): never {
    const error = operationFailure(code, message, cause);
    this.fail(sessionId, error.toFailure());
    throw error;
  }

  private resolvePending(sessionId: number): void {
    if (this.pendingOpen?.sessionId === sessionId) {
      this.pendingOpen.resolve();
      this.pendingOpen = null;
    }
  }

  private cancelPendingOpen(): void {
    if (this.pendingOpen) {
      this.pendingOpen.resolve();
      this.pendingOpen = null;
    }
  }

  private afterSeek(action: () => void | Promise<void>, wanted: () => boolean): Promise<void> {
    if (!wanted()) return Promise.resolve();
    if (this.pendingSeek) return this.pendingSeek.then(() => this.afterSeek(action, wanted));
    try { return Promise.resolve(action()); }
    catch (cause) { return Promise.reject(cause); }
  }

  private nativeSeek(milliseconds: number, success: () => void, error: (cause: unknown) => void): void {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    this.pendingSeek = pending;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      // AVPlay forbids every other API until either seek callback arrives.
      this.pendingSeek = null;
      release();
      callback();
    };
    try {
      this.avplay.seekTo(milliseconds, () => finish(success), cause => finish(() => error(cause)));
    } catch (cause) {
      finish(() => error(cause));
    }
  }

  private closeSafely(): void {
    try { this.avplay.close(); } catch { /* closing NONE/IDLE is implementation-specific */ }
  }

  private setDisplayRect(): void {
    if (!this.avplay.setDisplayRect) return;
    const width = typeof window === 'undefined' ? 1920 : Math.max(1, Math.floor(window.innerWidth));
    const height = typeof window === 'undefined' ? 1080 : Math.max(1, Math.floor(window.innerHeight));
    this.avplay.setDisplayRect(0, 0, width, height);
  }
}

function resolveAvplay(): AvplayManager {
  const runtime = globalThis as typeof globalThis & { webapis?: { avplay?: AvplayManager } };
  if (!runtime.webapis?.avplay) {
    throw new PlayerOperationError('engine-unavailable', 'Samsung AVPlay is unavailable in this runtime.');
  }
  return runtime.webapis.avplay;
}

function tracksFromAvplay(infos: readonly AvplayTrackInfo[]): PlayerTracks {
  const audio: PlayerTrack[] = [];
  const text: PlayerTrack[] = [];
  for (const info of infos) {
    if (info.type !== 'AUDIO' && info.type !== 'TEXT') continue;
    const kind = info.type === 'AUDIO' ? 'audio' : 'text';
    const metadata = parseExtraInfo(info.extra_info);
    const language = readString(metadata, 'language') ?? readString(metadata, 'track_lang') ?? readString(metadata, 'lang');
    const codec = readString(metadata, 'fourCC') ?? readString(metadata, 'codec');
    const label = [language, codec].filter(Boolean).join(' · ') || `${kind === 'audio' ? 'Audio' : 'Subtitle'} ${info.index}`;
    const track: PlayerTrack = { id: `${kind}:${info.index}`, label, language, available: true };
    (kind === 'audio' ? audio : text).push(track);
  }
  return { audio, text, selectedAudioId: null, selectedTextId: null };
}

function parseExtraInfo(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function parseTrackIndex(id: string): number {
  const index = Number(id.slice(id.indexOf(':') + 1));
  if (!Number.isInteger(index) || index < 0) throw new PlayerOperationError('unsupported-operation', `Invalid track identifier ${id}.`);
  return index;
}

function operationFailure(code: PlayerErrorCode, message: string, cause?: unknown): PlayerOperationError {
  return new PlayerOperationError(code, message, cause);
}
