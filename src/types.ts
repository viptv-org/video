/**
 * The only playback seam used by the shared TV UI.  It deliberately accepts an
 * already-selected delivery URL: choosing a source and choosing a server
 * delivery rung belong to the product/backend, never to a device adapter.
 */
export type PlayerPlatform = 'tizen' | 'vizio' | 'html5' | 'tauri';
export type PlaybackKind = 'vod' | 'live';
export type PlayerState =
  | 'idle'
  | 'opening'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'stopped'
  | 'error'
  | 'disposed';

export type CapabilityResult = 'supported' | 'unsupported' | 'probe-required';

export interface PlayerCapabilities {
  readonly platform: PlayerPlatform;
  readonly engine: string;
  readonly directNative: CapabilityResult;
  readonly adaptiveStreaming: CapabilityResult;
  readonly drm: CapabilityResult;
  readonly canSetVolume?: boolean;
  readonly canPause: boolean;
  readonly canSeek: boolean;
  readonly canSelectAudioTrack: boolean;
  readonly canSelectTextTrack: boolean;
  readonly canDisableTextTrack: boolean;
  readonly canUseCookies: boolean;
  readonly canUseUserAgent: boolean;
  readonly limitations: readonly string[];
}

export interface PlayerTrack {
  readonly id: string;
  readonly label: string;
  readonly language?: string;
  readonly available: boolean;
}

export interface PlayerTracks {
  readonly audio: readonly PlayerTrack[];
  readonly text: readonly PlayerTrack[];
  readonly selectedAudioId: string | null;
  readonly selectedTextId: string | null;
}

export interface PlayerTime {
  readonly positionSeconds: number;
  /** Null represents a live or engine-unknown duration. */
  readonly durationSeconds: number | null;
  /**
   * Furthest second the engine already holds decoded data for. Null or
   * omitted when the engine cannot report it; sessions never fake it.
   */
  readonly bufferedEndSeconds?: number | null;
}

export type PlayerErrorCode =
  | 'authorization-unsupported'
  | 'connection-failed'
  | 'engine-unavailable'
  | 'invalid-state'
  | 'prepare-failed'
  | 'seek-failed'
  | 'unsupported-operation'
  | 'unsupported-format'
  | 'unknown';

export interface PlayerFailure {
  readonly code: PlayerErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export interface PlayerDiagnostics {
  readonly engine: 'mediabunny' | 'native-html' | 'hls.js' | 'avplay' | 'tauri-native';
  readonly transport: 'hls' | 'file';
  readonly networkTransport?: 'browser-proxy' | 'direct' | 'native-http';
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly width?: number;
  readonly height?: number;
  readonly fallbackReason?: string;
}

export interface PlayerSnapshot {
  readonly diagnostics?: PlayerDiagnostics;
  readonly volume?: { readonly level: number; readonly muted: boolean };
  readonly sessionId: number;
  readonly state: PlayerState;
  readonly kind: PlaybackKind | null;
  readonly time: PlayerTime;
  readonly tracks: PlayerTracks;
  readonly error: PlayerFailure | null;
}

export interface PlaybackAuthorization {
  /** A server-provided Cookie header. The Vizio/HTML adapter cannot apply it. */
  readonly cookie?: string;
  /** A server-provided User-Agent. The Vizio/HTML adapter cannot apply it. */
  readonly userAgent?: string;
}

export interface OpenPlayerRequest {
  /** The exact source/delivery result selected outside this adapter. */
  readonly url: string;
  readonly kind: PlaybackKind;
  /** Native timeline position within this delivered URL. */
  readonly startAtSeconds?: number;
  /** Explicit audio-only consumers may opt out of first-video-frame validation. */
  readonly expectedVideo?: boolean;
  /** Absolute title time represented by native position zero for managed output. */
  readonly timelineOffsetSeconds?: number;
  /**
   * `managed` output is a rolling HLS window that a streaming engine must buffer
   * against; `direct` is the untouched original delivery. Omitted keeps the
   * file-decoder preference.
   */
  readonly deliveryMode?: 'direct' | 'managed';
  /** Container of this delivery, e.g. `hls` or `mp4`. */
  readonly deliveryFormat?: string;
  /**
   * The title's full length in seconds as known by the server. Managed output is
   * a rolling HLS window, so an engine duration describes only the buffered part
   * and must never be published as the title length.
   */
  readonly timelineDurationSeconds?: number;
  /**
   * True only for an original-file delivery, where the engine's own duration is
   * real evidence and may refine the server total upward.
   */
  readonly adoptEngineDuration?: boolean;
  readonly paused?: boolean;
  readonly authorization?: PlaybackAuthorization;
}

export type PlayerListener = (snapshot: PlayerSnapshot) => void;

export interface Player {
  readonly capabilities: PlayerCapabilities;
  readonly snapshot: PlayerSnapshot;
  setVolume?(level: number): Promise<void>;
  setMuted?(muted: boolean): Promise<void>;
  open(request: OpenPlayerRequest): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(positionSeconds: number): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  selectAudioTrack(trackId: string): Promise<void>;
  selectTextTrack(trackId: string | null): Promise<void>;
  subscribe(listener: PlayerListener): () => void;
}

export class PlayerOperationError extends Error {
  readonly code: PlayerErrorCode;

  constructor(code: PlayerErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PlayerOperationError';
    this.code = code;
  }

  toFailure(): PlayerFailure {
    return { code: this.code, message: this.message, cause: this.cause };
  }
}

function knownSeconds(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Mirrors the Roku player's duration rule: the server-known title length is
 * authoritative, and only an original-file engine may raise it. A rolling
 * managed window therefore never becomes the seek bar's duration.
 */
export function timelineDuration(
  authoritativeSeconds: number | undefined,
  engineSeconds: number | null,
  adoptEngineDuration = false,
): number | null {
  const known = knownSeconds(authoritativeSeconds);
  if (!adoptEngineDuration) return known;
  const engine = knownSeconds(engineSeconds);
  if (known === null) return engine;
  return engine !== null && engine > known ? engine : known;
}

/** A native seek target inside the delivery: never negative, never past its end. */
export function boundedPosition(position: number, duration: number | null): number {
  if (!Number.isFinite(position) || position <= 0) return 0;
  return duration === null ? position : Math.min(position, duration);
}

/**
 * The seek bar's length only grows. Mirrors the Roku player, where a later or
 * re-read engine value can raise the known duration but never shorten it.
 */
export function growOnlyDuration(previous: number | null, next: number | null): number | null {
  if (next === null) return previous;
  if (previous === null) return next;
  return next > previous ? next : previous;
}

export const EMPTY_TRACKS: PlayerTracks = {
  audio: [],
  text: [],
  selectedAudioId: null,
  selectedTextId: null,
};

export const IDLE_SNAPSHOT: PlayerSnapshot = {
  sessionId: 0,
  state: 'idle',
  kind: null,
  time: { positionSeconds: 0, durationSeconds: null },
  tracks: EMPTY_TRACKS,
  error: null,
};

/**
 * The server playback contract the controller and applications share. The
 * application binds its own API client to these shapes; the controller never
 * imports application or catalog code.
 */

/** A WebCodecs demuxer path: the original container is served instead of HLS. */
export interface DirectFileCapabilities {
  readonly directFiles?: boolean;
  readonly directVideoCodecs?: readonly string[];
  readonly directAudioCodecs?: readonly string[];
}

export interface PlaybackCapabilities extends DirectFileCapabilities {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly h264: boolean;
  readonly hevc: boolean;
  readonly aac: boolean;
  readonly directPlay: boolean;
  readonly directMp4?: boolean;
  readonly directHls?: boolean;
  /**
   * The client plays the ORIGINAL absolute source URL itself through a native
   * engine and never accepts managed (proxied or converted) delivery; the
   * controller must not escalate its sessions up the delivery ladder.
   */
  readonly directUrls?: boolean;
  readonly hevcSdr: boolean;
}

/** The request that starts or restarts one server playback session. */
export interface PlaybackStart {
  readonly streamId?: string;
  readonly channelId?: string;
  readonly position?: number;
  readonly capabilities: PlaybackCapabilities;
  readonly forceTranscode?: boolean;
  readonly managedOnly?: boolean;
  readonly audioTrackIndex?: number;
  readonly audioLanguage?: string;
  readonly subtitleTrackIndex?: number;
  readonly subtitlesOff?: boolean;
  readonly startupId?: string;
}

/** One selectable stream track the server reports for a playback session. */
export interface PlaybackMediaTrack {
  readonly inputIndex: number;
  readonly codec?: string;
  readonly language?: string;
  readonly languageStatus: string;
  readonly title: string;
  readonly selected: boolean;
  readonly supported: boolean;
  readonly selectable: boolean;
}

/** The server's opaque playback session as the controller and app consume it. */
export interface PlaybackSessionView {
  readonly headers: { readonly [key: string]: string };
  readonly id: string;
  readonly url: string;
  readonly format: string;
  readonly mode: string;
  readonly videoMode: string;
  readonly audioMode: string;
  readonly position: number;
  readonly live: boolean;
  readonly duration: number;
  readonly audioTracks: readonly PlaybackMediaTrack[];
  readonly subtitleTracks: readonly PlaybackMediaTrack[];
  readonly subtitlesSupported: boolean;
  /** Source credentials a direct-URL session carries for native playback. */
  readonly authorization?: PlaybackAuthorization;
}

/** A playback-port refusal: an HTTP-like status, with 0 meaning transport failure. */
export interface PlaybackBackendError extends Error {
  readonly status: number;
}
