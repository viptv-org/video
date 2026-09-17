import Hls from 'hls.js';
import { supportsNativeHls } from './browser-capabilities';
import { SessionPlayer } from './session';
import {
  type OpenPlayerRequest,
  PlayerOperationError,
  boundedPosition,
  growOnlyDuration,
  timelineDuration,
  type PlayerCapabilities,
  type PlayerTrack,
  type PlayerTracks,
} from './types';

export interface HtmlTextTrack {
  readonly kind: string;
  readonly label: string;
  readonly language: string;
  mode: 'disabled' | 'hidden' | 'showing';
}

export interface HtmlMediaLike {
  src: string;
  volume?: number;
  muted?: boolean;
  readonly videoWidth?: number;
  readonly videoHeight?: number;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly error: { readonly code: number; readonly message?: string } | null;
  readonly textTracks?: ArrayLike<HtmlTextTrack>;
  canPlayType?(type: string): string;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  removeAttribute?(name: string): void;
}

export const VIZIO_HTML5_CAPABILITIES: PlayerCapabilities = {
  platform: 'vizio',
  engine: 'HTMLMediaElement',
  directNative: 'probe-required',
  adaptiveStreaming: 'probe-required',
  drm: 'probe-required',
  canSetVolume: true,
  canPause: true,
  canSeek: true,
  canSelectAudioTrack: false,
  canSelectTextTrack: true,
  canDisableTextTrack: true,
  canUseCookies: false,
  canUseUserAgent: false,
  limitations: [
    'No public Vizio playback capability table is assumed; test the exact TV, firmware, source and duration.',
    'This adapter does not set request headers, cookies or audio tracks. Supply a backend-compatible signed/direct URL.',
    'HLS uses native playback first, then hls.js/MSE transmuxing when supported; WebCodecs is not a decoder path.',
    'Adaptive, DRM, seek and subtitle behavior are runtime probes, not platform-wide claims.',
  ],
};

/**
 * Vizio SmartCast uses the browser-native path. It owns no delivery fallback:
 * the backend selects direct/copy/remux/audio/full transcode before this URL is
 * handed to the adapter and records the selected rung.
 */
export class VizioHtml5Adapter extends SessionPlayer {
  readonly capabilities = VIZIO_HTML5_CAPABILITIES;
  private readonly handlers: Record<string, () => void>;
  private hls: Hls | null = null;
  private firstFrameTimer?: ReturnType<typeof setTimeout>;
  private expectedVideo = true;
  private nativeHlsFallback: (() => boolean) | null = null;
  private pauseRequested = false;
  private activeKind: OpenPlayerRequest['kind'] | null = null;
  private timelineOffsetSeconds = 0;
  private timelineDurationSeconds: number | undefined;
  private adoptEngineDuration = false;
  private observedTitleDuration: number | null = null;
  private pendingOpen: { readonly sessionId: number; readonly cancel: () => void } | null = null;

  constructor(private readonly media: HtmlMediaLike) {
    super();
    this.handlers = {
      volumechange: () => this.onVolume(),
      loadedmetadata: () => this.onMetadata(),
      canplay: () => this.onCanPlay(),
      play: () => this.onPlay(),
      pause: () => this.onPause(),
      waiting: () => this.onWaiting(),
      playing: () => this.onPlay(),
      timeupdate: () => this.onTimeUpdate(),
      ended: () => this.onEnded(),
      error: () => this.onError(),
    };
    for (const [event, handler] of Object.entries(this.handlers)) this.media.addEventListener(event, handler);
  }

  open(request: OpenPlayerRequest): Promise<void> {
    if (request.authorization?.cookie || request.authorization?.userAgent) {
      return Promise.reject(new PlayerOperationError(
        'unsupported-operation',
        'The Vizio HTML player cannot attach credentials. Use a backend-compatible URL instead.',
      ));
    }
    this.nativeHlsFallback = null;
    this.clearFirstFrameWatchdog();
    this.cancelPendingOpen();
    this.destroyHls();
    this.invalidateSession();
    this.pauseRequested = request.paused ?? false;
    this.expectedVideo = request.expectedVideo !== false;
    const sessionId = this.startSession(request.kind);
    this.update(sessionId, { diagnostics: { engine: 'native-html', networkTransport: new URL(request.url, location.href).pathname.startsWith('/media/') ? 'browser-proxy' : 'direct', transport: /\.m3u8(?:[?#]|$)/i.test(request.url) ? 'hls' : 'file' }, volume: { level: this.media.volume ?? 1, muted: this.media.muted ?? false } });
    this.activeKind = request.kind;
    this.timelineOffsetSeconds = nonNegative(request.timelineOffsetSeconds ?? 0);
    this.timelineDurationSeconds = request.timelineDurationSeconds;
    this.adoptEngineDuration = request.adoptEngineDuration === true;
    this.observedTitleDuration = null;
    this.media.pause();
    return new Promise<void>((resolve, reject) => {
      let openingTimer: ReturnType<typeof setTimeout> | undefined;
      let targetPosition = request.startAtSeconds ?? 0;
      let attempt = 0;
      const cleanup = () => {
        clearTimeout(openingTimer);
        this.media.removeEventListener('loadedmetadata', onReady);
        this.media.removeEventListener('error', onFailure);
      };
      const onReady = () => {
        if (!this.isCurrent(sessionId)) {
          cleanup();
          resolve();
          return;
        }
        cleanup();
        const readyAttempt = attempt;
        this.watchFirstFrame(sessionId);
        const target = boundedPosition(targetPosition, knownDuration(this.media.duration));
        try { this.media.currentTime = target; } catch { /* browser may delay seek until a later ready state */ }
        this.update(sessionId, {
          state: this.pauseRequested ? 'paused' : 'ready',
          time: { positionSeconds: this.timelineOffsetSeconds + target, durationSeconds: this.titleDuration() },
          tracks: tracksFromMedia(this.media),
          error: null,
        });
        if (this.pauseRequested) {
          this.pendingOpen = null;
          resolve();
          return;
        }
        this.media.play().then(
          () => { if (this.isCurrent(sessionId) && readyAttempt === attempt) { this.pendingOpen = null; resolve(); } },
          (cause) => {
            if (!this.isCurrent(sessionId)) return resolve();
            if (readyAttempt !== attempt) return;
            if (this.nativeHlsFallback?.()) return;
            const error = this.media.error ? mediaError(this.media, 'prepare-failed')
              : new PlayerOperationError('prepare-failed', 'The browser could not start the selected source.', cause);
            this.fail(sessionId, error.toFailure());
            reject(error);
          },
        );
      };
      const onFailure = () => {
        // load() clears an obsolete native error while the same dispatch is
        // switching to MSE. That old event must not reject the new attempt.
        if (!this.media.error) return;
        if (this.nativeHlsFallback?.()) return;
        if (!this.isCurrent(sessionId)) {
          cleanup();
          resolve();
          return;
        }
        cleanup();
        const error = mediaError(this.media, 'prepare-failed');
        this.nativeHlsFallback = null;
        this.destroyHls();
        this.fail(sessionId, error.toFailure());
        this.pendingOpen = null;
        reject(error);
      };
      // Metadata is the earliest portable point at which the resume target and
      // finite VOD duration are meaningful. Old TV browsers need not emit the
      // later canplay event before play() is allowed.
      this.media.addEventListener('loadedmetadata', onReady);
      this.media.addEventListener('error', onFailure);
      this.pendingOpen = { sessionId, cancel: () => { cleanup(); resolve(); } };
      const failOpen = (error: PlayerOperationError) => {
        if (!this.isCurrent(sessionId)) return;
        cleanup();
        this.pendingOpen = null;
        this.nativeHlsFallback = null;
        this.destroyHls();
        this.fail(sessionId, error.toFailure());
        reject(error);
      };
      openingTimer = setTimeout(() => failOpen(new PlayerOperationError('prepare-failed', 'The selected source did not become ready in time.')), 20000);
      const startMse = () => {
        this.update(sessionId, { diagnostics: { engine: 'hls.js', networkTransport: 'browser-proxy', transport: 'hls' } });
        if (!Hls.isSupported()) throw new PlayerOperationError('unsupported-format', 'This browser cannot play HLS. Native HLS or MediaSource support is required.');
        const url = checkedMediaUrl(request.url);
        const prefix = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
        const hls = new Hls({
          maxBufferLength: 20,
          maxMaxBufferLength: 30,
          backBufferLength: 10,
          xhrSetup: (_xhr, resourceUrl) => {
            const resource = checkedMediaUrl(resourceUrl);
            if (!resource.pathname.startsWith(prefix)) throw new Error('HLS resource is outside the playback session.');
          },
        });
        this.hls = hls;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || !this.isCurrent(sessionId)) return;
          failOpen(new PlayerOperationError(data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'connection-failed' : 'unsupported-format', 'The selected HLS source could not be played.'));
        });
        hls.attachMedia(this.media as HTMLMediaElement);
        hls.loadSource(url.href);
      };
      try {
        const isHls = /\.m3u8(?:[?#]|$)/i.test(request.url);
        if (isHls && !supportsNativeHls(this.media)) startMse();
        else {
          if (isHls && Hls.isSupported()) {
            // A native MIME hint is not decode evidence. Some Chromium builds
            // advertise HLS, then reject valid MPEG-TS playlists after metadata.
            // Retry that exact capability locally once, before server escalation.
            this.nativeHlsFallback = () => {
              if (!this.isCurrent(sessionId) || ![3, 4].includes(this.media.error?.code ?? 0)) return false;
              this.nativeHlsFallback = null;
              attempt++;
              if (request.kind !== 'live' && Number.isFinite(this.media.currentTime) && this.media.currentTime > 0)
                targetPosition = this.media.currentTime;
              cleanup();
              this.media.removeAttribute?.('src');
              this.media.load();
              this.update(sessionId, { state: 'buffering', error: null });
              this.media.addEventListener('loadedmetadata', onReady);
              this.media.addEventListener('error', onFailure);
              this.pendingOpen = { sessionId, cancel: () => { cleanup(); resolve(); } };
              openingTimer = setTimeout(() => failOpen(new PlayerOperationError('prepare-failed', 'The selected source did not become ready in time.')), 20000);
              try { startMse(); }
              catch (cause) { failOpen(cause instanceof PlayerOperationError ? cause : new PlayerOperationError('prepare-failed', 'The browser could not prepare the selected source.', cause)); }
              return true;
            };
          }
          this.media.src = request.url;
          this.media.load();
        }
      } catch (cause) {
        failOpen(cause instanceof PlayerOperationError ? cause : new PlayerOperationError('prepare-failed', 'The browser could not prepare the selected source.', cause));
      }
    });
  }

  async play(): Promise<void> {
    this.pauseRequested = false;
    const sessionId = this.activeSessionOrThrow();
    try {
      await this.media.play();
      this.update(sessionId, { state: 'playing', error: null });
    } catch (cause) {
      const error = new PlayerOperationError('prepare-failed', 'The browser could not resume playback.', cause);
      this.fail(sessionId, error.toFailure());
      throw error;
    }
  }

  async pause(): Promise<void> {
    this.pauseRequested = true;
    const sessionId = this.activeSessionOrThrow();
    this.media.pause();
    this.onTimeUpdate();
    this.update(sessionId, { state: 'paused' });
  }

  async seek(positionSeconds: number): Promise<void> {
    const sessionId = this.activeSessionOrThrow();
    if (this.activeKind === 'live') throw new PlayerOperationError('unsupported-operation', 'Live playback does not expose VOD seeking.');
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) throw new PlayerOperationError('seek-failed', 'Seek position must be a non-negative number.');
    try {
      const target = boundedPosition(positionSeconds - this.timelineOffsetSeconds, knownDuration(this.media.duration));
      this.media.currentTime = target;
      this.update(sessionId, { time: { positionSeconds: this.timelineOffsetSeconds + target, durationSeconds: this.titleDuration() } });
    } catch (cause) {
      const error = new PlayerOperationError('seek-failed', 'The browser could not seek the selected source.', cause);
      this.fail(sessionId, error.toFailure());
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.nativeHlsFallback = null;
    this.clearFirstFrameWatchdog();
    this.cancelPendingOpen();
    this.destroyHls();
    this.invalidateSession();
    this.activeKind = null;
    this.media.pause();
    this.media.removeAttribute?.('src');
    this.media.load();
    this.terminal('stopped');
  }

  async dispose(): Promise<void> {
    await this.stop();
    for (const [event, handler] of Object.entries(this.handlers)) this.media.removeEventListener(event, handler);
    this.terminal('disposed');
  }

  async selectAudioTrack(_: string): Promise<void> {
    throw new PlayerOperationError('unsupported-operation', 'The Vizio HTML player does not expose audio-track selection.');
  }

  async selectTextTrack(trackId: string | null): Promise<void> {
    const sessionId = this.activeSessionOrThrow();
    const tracks = selectableTextTracks(this.media);
    if (trackId === null) {
      for (const { track } of tracks) track.mode = 'disabled';
      this.update(sessionId, { tracks: { ...this.snapshot.tracks, selectedTextId: null } });
      return;
    }
    const selected = tracks.find((entry) => entry.id === trackId);
    if (!selected) throw new PlayerOperationError('unsupported-operation', `Subtitle track ${trackId} is not available.`);
    for (const { track } of tracks) track.mode = track === selected.track ? 'showing' : 'disabled';
    this.update(sessionId, { tracks: { ...tracksFromMedia(this.media), selectedTextId: trackId } });
  }

  async setVolume(level: number): Promise<void> {
    this.media.volume = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 1));
    if (this.media.volume > 0) this.media.muted = false;
    this.onVolume();
  }
  async setMuted(muted: boolean): Promise<void> { this.media.muted = muted; this.onVolume(); }
  private onVolume(): void { this.update(this.snapshot.sessionId, { volume: { level: this.media.volume ?? 1, muted: this.media.muted ?? false } }); }
  private clearFirstFrameWatchdog(): void { clearTimeout(this.firstFrameTimer); this.firstFrameTimer = undefined; }
  private watchFirstFrame(sessionId: number): void {
    if (!this.expectedVideo || this.media.videoWidth === undefined || this.media.videoWidth > 0 || this.firstFrameTimer) return;
    this.firstFrameTimer = setTimeout(() => {
      this.firstFrameTimer = undefined;
      if (!this.isCurrent(sessionId) || (this.media.videoWidth ?? 0) > 0 || this.snapshot.state === 'error') return;
      this.nativeHlsFallback = null;
      this.fail(sessionId, { code: 'unsupported-format', message: 'The selected source did not produce a decoded video frame.' });
      this.media.pause(); this.destroyHls();
    }, 8000);
  }
  /** The seek bar's length: the server total, raised only by an original file. */
  private titleDuration(): number | null {
    const next = timelineDuration(this.timelineDurationSeconds, knownDuration(this.media.duration), this.adoptEngineDuration);
    return (this.observedTitleDuration = growOnlyDuration(this.observedTitleDuration, next));
  }

  private onMetadata(): void {
    if ((this.media.videoWidth ?? 0) > 0) this.clearFirstFrameWatchdog();
    const sessionId = this.snapshot.sessionId;
    if (!this.isCurrent(sessionId)) return;
    this.update(sessionId, { diagnostics: this.snapshot.diagnostics ? { ...this.snapshot.diagnostics, width: this.media.videoWidth, height: this.media.videoHeight } : undefined, time: { positionSeconds: this.timelineOffsetSeconds + this.media.currentTime, durationSeconds: this.titleDuration() }, tracks: tracksFromMedia(this.media) });
  }

  private onCanPlay(): void { this.onMetadata(); }
  private onPlay(): void {
    if (this.media.error || this.snapshot.state === 'error') return;
    const sessionId = this.snapshot.sessionId;
    this.update(sessionId, { state: 'playing', error: null });
  }
  private onPause(): void {
    const sessionId = this.snapshot.sessionId;
    if (!this.media.ended && !this.media.error && this.snapshot.state !== 'error')
      this.update(sessionId, { state: 'paused' });
  }
  private onWaiting(): void {
    if (this.media.error || this.snapshot.state === 'error') return;
    const sessionId = this.snapshot.sessionId;
    this.update(sessionId, { state: 'buffering' });
  }
  private onTimeUpdate(): void {
    if ((this.media.videoWidth ?? 0) > 0) this.clearFirstFrameWatchdog();
    const sessionId = this.snapshot.sessionId;
    this.update(sessionId, { diagnostics: this.snapshot.diagnostics ? { ...this.snapshot.diagnostics, width: this.media.videoWidth, height: this.media.videoHeight } : undefined, time: { positionSeconds: this.timelineOffsetSeconds + this.media.currentTime, durationSeconds: this.titleDuration() } });
  }
  private onEnded(): void {
    if (this.media.error || this.snapshot.state === 'error') return;
    const sessionId = this.snapshot.sessionId;
    this.update(sessionId, { state: 'ended' });
  }
  private onError(): void {
    if (this.nativeHlsFallback?.()) return;
    if (!this.media.error) return;
    const sessionId = this.snapshot.sessionId;
    this.fail(sessionId, mediaError(this.media, 'connection-failed').toFailure());
  }

  private destroyHls(): void {
    this.hls?.destroy();
    this.hls = null;
  }

  private cancelPendingOpen(): void {
    if (this.pendingOpen) {
      this.pendingOpen.cancel();
      this.pendingOpen = null;
    }
  }
}

function listTextTracks(media: HtmlMediaLike): HtmlTextTrack[] {
  if (!media.textTracks) return [];
  return Array.from({ length: media.textTracks.length }, (_, index) => media.textTracks![index]);
}

/** Preserve native indices: filtered-array indices cannot select the right cue. */
function selectableTextTracks(media: HtmlMediaLike): readonly { readonly id: string; readonly track: HtmlTextTrack }[] {
  return listTextTracks(media).flatMap((track, index) => (
    track.kind === 'captions' || track.kind === 'subtitles'
      ? [{ id: `text:${index}`, track }]
      : []
  ));
}

function tracksFromMedia(media: HtmlMediaLike): PlayerTracks {
  const tracks = selectableTextTracks(media);
  const text = tracks
    .map(({ id, track }, index): PlayerTrack => ({
      id,
      label: track.label || `Subtitle ${index + 1}`,
      language: track.language || undefined,
      available: true,
    }));
  const selectedTextId = tracks.find((entry) => entry.track.mode === 'showing')?.id ?? null;
  return { audio: [], text, selectedAudioId: null, selectedTextId };
}

function knownDuration(duration: number): number | null {
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function mediaError(media: HtmlMediaLike, code: 'prepare-failed' | 'connection-failed'): PlayerOperationError {
  const message = media.error?.message ?? `HTML media error ${media.error?.code ?? 'unknown'}.`;
  return new PlayerOperationError(media.error?.code === 3 || media.error?.code === 4 ? 'unsupported-format' : code, message, media.error);
}

/** hls.js fetches only the backend's scoped media capability; it is never a URL proxy. */
function checkedMediaUrl(value: string): URL {
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/media/') || url.username || url.password) {
    throw new PlayerOperationError('authorization-unsupported', 'HLS requires a same-origin backend media session.');
  }
  return url;
}
