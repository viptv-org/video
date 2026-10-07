import Hls, { FetchLoader } from 'hls.js';
import { hasSourceAuthorization } from './source-authorization';
import { checkedMediaDelivery, sessionMediaRequest } from './session-media-fetch';
import { supportsNativeHls } from './browser-capabilities';
import { SessionPlayer } from './session';
import { mediaFailure } from './browser-policy';
import { nonNegative } from './primitives';
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
  crossOrigin?: string | null;
  readonly audioTracks?: ArrayLike<{ label: string; language: string; enabled: boolean }>;
  src: string;
  volume?: number;
  muted?: boolean;
  readonly videoWidth?: number;
  readonly videoHeight?: number;
  getVideoPlaybackQuality?(): { readonly totalVideoFrames: number };
  currentTime: number;
  readonly duration: number;
  readonly buffered?: { readonly length: number; start(index: number): number; end(index: number): number } | null;
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
  get capabilities(): PlayerCapabilities { return { ...VIZIO_HTML5_CAPABILITIES, canSelectAudioTrack: !!this.hls || !!this.media.audioTracks?.length }; }
  private readonly handlers: Record<string, () => void>;
  private hls: Hls | null = null;
  private firstFrameTimer?: ReturnType<typeof setTimeout>;
  private expectedVideo = true;
  private nativeHlsFallback: ((stalled?: boolean) => boolean) | null = null;
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
      progress: () => this.onProgress(),
      ended: () => this.onEnded(),
      error: () => this.onError(),
    };
    for (const [event, handler] of Object.entries(this.handlers)) this.media.addEventListener(event, handler);
  }

  open(request: OpenPlayerRequest): Promise<void> {
    try { checkedMediaDelivery(request.url); }
    catch (error) { return Promise.reject(error); }
    if (hasSourceAuthorization(request.authorization)) {
      return Promise.reject(new PlayerOperationError(
        'authorization-unsupported',
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
    this.update(sessionId, { diagnostics: { decision: request.deliveryDecision, engine: 'native-html', networkTransport: new URL(request.url, location.href).pathname.startsWith('/media/') ? 'browser-proxy' : 'direct', transport: /\.m3u8(?:[?#]|$)/i.test(request.url) ? 'hls' : 'file' }, volume: { level: this.media.volume ?? 1, muted: this.media.muted ?? false } });
    this.activeKind = request.kind;
    this.timelineOffsetSeconds = nonNegative(request.timelineOffsetSeconds ?? 0);
    this.timelineDurationSeconds = request.timelineDurationSeconds;
    this.adoptEngineDuration = request.adoptEngineDuration === true;
    this.observedTitleDuration = null;
    this.media.pause();
    this.media.crossOrigin = 'anonymous';
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
        const target = request.kind === 'live'
          ? Math.max(0, this.hls?.liveSyncPosition ?? this.media.currentTime ?? 0)
          : boundedPosition(targetPosition, knownDuration(this.media.duration));
        try { this.media.currentTime = target; } catch { /* browser may delay seek until a later ready state */ }
        this.update(sessionId, {
          state: this.pauseRequested ? 'paused' : 'ready',
          time: { positionSeconds: this.timelineOffsetSeconds + target, durationSeconds: this.titleDuration() },
          tracks: this.tracks(),
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
        this.update(sessionId, { diagnostics: { decision: request.deliveryDecision, engine: 'hls.js', networkTransport: 'browser-proxy', transport: 'hls' } });
        if (!Hls.isSupported()) throw new PlayerOperationError('unsupported-format', 'This browser cannot play HLS. Native HLS or MediaSource support is required.');
        const url = checkedMediaDelivery(request.url);
        const hls = new Hls({
          // A 2016-2020 SmartCast TV's Wi-Fi commonly sustains ~5-10 Mbps with
          // 150 ms latency; at a 4 Mbps rendition the previous 20 s forward
          // window drained during single-segment hiccups and rebuffered every
          // few seconds. 45 s forward (75 s hard ceiling) rides out transcode
          // pacing jitter at ~20 MB RAM on this device class; the 30 s back
          // buffer keeps seeks cheap.
          maxBufferLength: 45,
          maxMaxBufferLength: 75,
          backBufferLength: 30,
          maxBufferSize: 60 * 1000 * 1000,
          loader: FetchLoader,
          fetchSetup: (context, init) => sessionMediaRequest(url.href, context.url, init),
        });
        this.hls = hls;
        // Consecutive non-fatal network failures stall the video silently
        // (buffer drains, spinner forever). hls.js keeps retrying internally,
        // so three in a row with no successful load in between escalates to a
        // classified error the UI can surface; any successful load resets it.
        let consecutiveNetworkFailures = 0;
        const publishTracks = () => {
          if (!this.isCurrent(sessionId)) return;
          this.update(sessionId, { tracks: this.tracks(), qualities: (hls.levels ?? []).map((level, index) => ({
            id: `hls:${index}`, label: `${level.height}p`, width: level.width, height: level.height, bitrate: level.bitrate,
          })), selectedQualityId: hls.autoLevelEnabled ? 'auto' : `hls:${hls.currentLevel}` });
        };
        hls.on(Hls.Events.MANIFEST_PARSED, publishTracks);
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, publishTracks);
        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, publishTracks);
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, publishTracks);
        hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, publishTracks);
        hls.on(Hls.Events.LEVEL_UPDATED, () => { consecutiveNetworkFailures = 0; });
        hls.on(Hls.Events.FRAG_LOADED, () => { consecutiveNetworkFailures = 0; });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!this.isCurrent(sessionId)) return;
          if (!data.fatal && data.response?.code !== 406) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && ++consecutiveNetworkFailures >= 3) {
              failOpen(new PlayerOperationError('connection-failed', 'The stream connection kept failing. Retry playback or choose another source.', undefined, 'network'));
            }
            return;
          }
          failOpen(new PlayerOperationError(data.response?.code === 406 ? 'unsupported-format' : data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'connection-failed' : 'unsupported-format', 'The selected HLS source could not be played.', undefined, data.response?.code === 406 ? 'container' : undefined));
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
            this.nativeHlsFallback = (stalled = false) => {
              if (!this.isCurrent(sessionId) || !stalled && ![3, 4].includes(this.media.error?.code ?? 0)) return false;
              this.nativeHlsFallback = null;
              this.clearFirstFrameWatchdog();
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
      this.watchFirstFrame(sessionId);
      this.update(sessionId, { state: 'playing', error: null });
    } catch (cause) {
      const error = mediaFailure(cause);
      this.fail(sessionId, error.toFailure());
      throw error;
    }
  }

  async pause(): Promise<void> {
    this.pauseRequested = true;
    this.clearFirstFrameWatchdog();
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

  async selectAudioTrack(id: string): Promise<void> {
    if (!this.hls) {
      const index = /^audio:(\d+)$/.exec(id)?.[1];
      const tracks = Array.from(this.media.audioTracks ?? []);
      if (index === undefined || !tracks[Number(index)]) throw new PlayerOperationError('unsupported-operation', 'This audio track is unavailable.');
      tracks.forEach((track, at) => { track.enabled = at === Number(index); });
      this.update(this.snapshot.sessionId, { tracks: this.tracks() }); return;
    }
    const index = /^hls-audio:(\d+)$/.exec(id)?.[1];
    if (!this.hls || index === undefined || !this.hls.audioTracks[Number(index)]) throw new PlayerOperationError('unsupported-operation', 'This audio track is unavailable.');
    this.hls.audioTrack = Number(index); this.update(this.snapshot.sessionId, { tracks: this.tracks() });
  }
  async selectQuality(id: string): Promise<void> {
    if (!this.hls) throw new PlayerOperationError('unsupported-operation', 'Quality selection is unavailable.');
    const index = id === 'auto' ? -1 : Number(/^hls:(\d+)$/.exec(id)?.[1]);
    if (!Number.isInteger(index) || index < -1 || index >= this.hls.levels.length) throw new PlayerOperationError('unsupported-operation', 'Quality is unavailable.');
    this.hls.currentLevel = index; this.update(this.snapshot.sessionId, { selectedQualityId: id });
  }
  private tracks(): PlayerTracks {
    if (!this.hls) return tracksFromMedia(this.media);
    return {
      audio: (this.hls.audioTracks ?? []).map((track, index) => ({ id: `hls-audio:${index}`, label: track.name || track.lang || `Audio ${index + 1}`, language: track.lang, available: true })),
      text: (this.hls.subtitleTracks ?? []).map((track, index) => ({ id: `hls-text:${index}`, label: track.name || track.lang || `Subtitle ${index + 1}`, language: track.lang, available: true })),
      selectedAudioId: this.hls.audioTrack >= 0 ? `hls-audio:${this.hls.audioTrack}` : null,
      selectedTextId: this.hls.subtitleTrack >= 0 ? `hls-text:${this.hls.subtitleTrack}` : null,
    };
  }

  async selectTextTrack(trackId: string | null): Promise<void> {
    const sessionId = this.activeSessionOrThrow();
    if (this.hls) {
      const index = trackId === null ? -1 : Number(/^hls-text:(\d+)$/.exec(trackId)?.[1]);
      if (!Number.isInteger(index) || index < -1 || index >= this.hls.subtitleTracks.length) throw new PlayerOperationError('unsupported-operation', 'Subtitle is unavailable.');
      this.hls.subtitleTrack = index; this.hls.subtitleDisplay = index >= 0;
      this.update(sessionId, { tracks: this.tracks() }); return;
    }
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
  private hasVideoFrame(): boolean {
    const frames = this.media.getVideoPlaybackQuality?.().totalVideoFrames;
    return (this.media.videoWidth ?? 0) > 0 && (frames === undefined || frames > 0);
  }
  private watchFirstFrame(sessionId: number): void {
    if (!this.expectedVideo || this.pauseRequested || this.media.videoWidth === undefined || this.hasVideoFrame() || this.firstFrameTimer) return;
    this.firstFrameTimer = setTimeout(() => {
      this.firstFrameTimer = undefined;
      if (!this.isCurrent(sessionId) || this.pauseRequested || this.hasVideoFrame() || this.snapshot.state === 'error') return;
      if (this.nativeHlsFallback?.(true)) return;
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
    if (this.hasVideoFrame()) this.clearFirstFrameWatchdog();
    const sessionId = this.snapshot.sessionId;
    if (!this.isCurrent(sessionId)) return;
    this.update(sessionId, { diagnostics: this.snapshot.diagnostics ? { ...this.snapshot.diagnostics, width: this.media.videoWidth, height: this.media.videoHeight } : undefined, time: { positionSeconds: this.timelineOffsetSeconds + this.media.currentTime, durationSeconds: this.titleDuration() }, tracks: this.tracks() });
  }

  private onCanPlay(): void { this.onMetadata(); }
  private onPlay(): void {
    if (this.media.error || this.snapshot.state === 'error') return;
    const sessionId = this.snapshot.sessionId;
    this.update(sessionId, { state: 'playing', error: null });
  }
  private onPause(): void {
    if (this.pauseRequested) this.clearFirstFrameWatchdog();
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
    if (this.hasVideoFrame()) this.clearFirstFrameWatchdog();
    const sessionId = this.snapshot.sessionId;
    this.update(sessionId, { diagnostics: this.snapshot.diagnostics ? { ...this.snapshot.diagnostics, width: this.media.videoWidth, height: this.media.videoHeight } : undefined, time: this.publishableTime() });
  }
  /**
   * `progress` fires while data downloads even when `timeupdate` is silent
   * (mid-stall buffering, paused prefetch). Publishing here keeps the UI's
   * buffered ranges advancing during exactly the states where the viewer
   * watches the bar; ranges stay engine-reported, never invented.
   */
  private onProgress(): void {
    if (this.media.error || this.snapshot.state === 'error') return;
    this.update(this.snapshot.sessionId, { time: this.publishableTime() });
  }
  private publishableTime(): { positionSeconds: number; durationSeconds: number | null; bufferedRanges?: { start: number; end: number }[]; bufferedEndSeconds?: number | null } {
    const time = { positionSeconds: this.timelineOffsetSeconds + this.media.currentTime, durationSeconds: this.titleDuration() };
    const ranges = this.engineBufferedRanges();
    if (!ranges) return time;
    return { ...time, bufferedRanges: ranges, bufferedEndSeconds: ranges[ranges.length - 1]?.end ?? null };
  }
  private engineBufferedRanges(): { start: number; end: number }[] | null {
    const buffered = this.media.buffered;
    if (!buffered || !buffered.length) return null;
    const ranges: { start: number; end: number }[] = [];
    for (let index = 0; index < buffered.length; index += 1) {
      const start = this.timelineOffsetSeconds + buffered.start(index);
      const end = this.timelineOffsetSeconds + buffered.end(index);
      if (end > start) ranges.push({ start, end });
    }
    return ranges.length ? ranges : null;
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
  const audio = Array.from(media.audioTracks ?? []).map((track, index) => ({ id: `audio:${index}`, label: track.label || track.language || `Audio ${index + 1}`, language: track.language, available: true }));
  const selectedAudio = Array.from(media.audioTracks ?? []).findIndex(track => track.enabled);
  return { audio, text, selectedAudioId: selectedAudio >= 0 ? `audio:${selectedAudio}` : null, selectedTextId };
}

function knownDuration(duration: number): number | null {
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function mediaError(media: HtmlMediaLike, code: 'prepare-failed' | 'connection-failed'): PlayerOperationError {
  const message = media.error?.message ?? `HTML media error ${media.error?.code ?? 'unknown'}.`;
  return new PlayerOperationError(media.error?.code === 3 || media.error?.code === 4 ? 'unsupported-format' : code, message, media.error);
}
