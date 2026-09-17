import { invoke } from '@tauri-apps/api/core';
import type { PlaybackCapabilities } from './types';
import { SessionPlayer } from './session';
import {
  PlayerOperationError,
  boundedPosition,
  growOnlyDuration,
  timelineDuration,
  type OpenPlayerRequest,
  type PlayerCapabilities,
  type PlayerErrorCode,
  type PlayerTime,
  type PlayerTrack,
  type PlayerTracks,
} from './types';

/**
 * The desktop playback seam. It implements the same Player contract as the TV
 * adapters directly over the raw tauri-plugin-video IPC commands
 * (`plugin:video|native_*`), so no @get-air/video dependency enters this
 * bundle: the command payloads, snapshots and wire errors are exactly the ones
 * the plugin's Rust side declares (tauri-plugin-video 0.4, protocol 1).
 *
 * What that engine actually exposes, and what this adapter honestly does not:
 * the native engines render through their own surface — a GTK GPU widget under
 * a WebView aperture on Linux, a WebView2 texture stream on the real video
 * element on Windows — never a canvas. Playback-rate changes and a buffering
 * signal are not part of the command protocol, so neither is reported nor
 * emulated here.
 */
export const TAURI_VIDEO_PROTOCOL_VERSION = 1;
/** Identifies this adapter in native_open; the Rust gate only requires presence. */
const ADAPTER_PACKAGE_VERSION = 'viptv-tv-web-tauri-native';
const COMMAND = 'plugin:video|';
const FIRST_FRAME_TIMEOUT_MS = 8000;

export type NativeVideoPlatform = 'linux' | 'windows';

/** The host-side command surface of tauri-plugin-video, injectable for tests. */
export interface TauriVideoInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface NativeVideoDiagnostics {
  readonly protocolVersion: number;
  readonly crateName: string;
  readonly crateVersion: string;
  readonly platform: string;
}

export interface NativeVideoTrack {
  readonly id: string;
  readonly index: number;
  readonly kind: 'video' | 'audio' | 'subtitle';
  readonly language: string;
  readonly label: string;
  readonly codec: string;
  readonly selected: boolean;
}

export interface NativeVideoSnapshot {
  readonly durationSeconds: number;
  readonly currentTimeSeconds: number;
  readonly bufferedSeconds: number;
  readonly live?: boolean;
  readonly seekable?: boolean;
  readonly seekableStartSeconds?: number;
  readonly seekableEndSeconds?: number;
  readonly playing: boolean;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly tracks: readonly NativeVideoTrack[];
  readonly presentedFrames?: number;
  readonly droppedFrames?: number;
  readonly measuredFps?: number;
  readonly hardwareBackend?: string;
}

interface NativeWireError {
  readonly code: string;
  readonly message: string;
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Resolves the real plugin bridge; outside Tauri this is an honest failure. */
export function resolveTauriVideoInvoker(): TauriVideoInvoker {
  if (!isTauriRuntime()) {
    throw new PlayerOperationError(
      'engine-unavailable',
      'The native Tauri video engine is unavailable outside the desktop app.',
    );
  }
  return { invoke };
}

export function tauriNativePlatform(): NativeVideoPlatform | undefined {
  if (/Windows/i.test(navigator.userAgent)) return 'windows';
  if (/Linux|X11/i.test(navigator.userAgent)) return 'linux';
  return undefined;
}

export const TAURI_NATIVE_PLAYER_CAPABILITIES: PlayerCapabilities = {
  platform: 'tauri',
  engine: 'tauri-plugin-video (native GStreamer)',
  directNative: 'supported',
  adaptiveStreaming: 'supported',
  drm: 'unsupported',
  canSetVolume: true,
  canPause: true,
  canSeek: true,
  canSelectAudioTrack: true,
  canSelectTextTrack: true,
  canDisableTextTrack: true,
  canUseCookies: true,
  canUseUserAgent: true,
  limitations: [
    'Native engine, codec and HDR support are runtime facts of the installed GStreamer build; the delivery profile only declares what the engine is expected to play.',
    'The native command protocol exposes no playback-rate change and no buffering signal; neither is reported or emulated.',
    'Cookies and a user agent are engine request properties, not arbitrary header support.',
    'Live windows are playable but expose no VOD seek bar, matching the other adapters.',
  ],
};

/**
 * The desktop no-transcode delivery profile handed to the backend's session
 * ladder: a broad native codec and container set with direct delivery
 * preferred. The server's own container, single-stream and HDR rules still
 * decide the rung; this client never requests managed-only or forced output.
 */
export const TAURI_NATIVE_DELIVERY_CAPABILITIES: PlaybackCapabilities = {
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
  directVideoCodecs: ['avc', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg2video', 'mpeg4', 'theora', 'prores', 'mjpeg'],
  directAudioCodecs: ['aac', 'opus', 'mp3', 'vorbis', 'flac', 'ac3', 'eac3', 'dts', 'truehd', 'pcm'],
};

interface NativeLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const LAYOUT_VARIABLES = [
  '--tauri-native-video-left',
  '--tauri-native-video-top',
  '--tauri-native-video-right',
  '--tauri-native-video-bottom',
  '--tauri-native-video-width',
  '--tauri-native-video-height',
] as const;

let nativeSessionSequence = 0;

interface WebView2TextureStreamApi {
  getTextureStream(streamId: string): Promise<MediaStream>;
}

function webView2TextureStream(): WebView2TextureStreamApi | undefined {
  const scope = globalThis as typeof globalThis & {
    chrome?: { webview?: Partial<WebView2TextureStreamApi> };
  };
  const getTextureStream = scope.chrome?.webview?.getTextureStream;
  return typeof getTextureStream === 'function'
    ? { getTextureStream: getTextureStream.bind(scope.chrome?.webview) }
    : undefined;
}

function newSessionKey(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `viptv-native-${Date.now()}-${++nativeSessionSequence}`;
}

function isWireError(value: unknown): value is NativeWireError {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { code?: unknown }).code === 'string'
    && typeof (value as { message?: unknown }).message === 'string';
}

/** The plugin's serialized engine failures map onto the shared Player codes. */
function playerErrorCodeFor(wireCode: string | undefined, fallback: PlayerErrorCode): PlayerErrorCode {
  switch (wireCode) {
    case 'PROTOCOL_MISMATCH':
    case 'RUNTIME_UNAVAILABLE':
      return 'engine-unavailable';
    // A pipeline failure means the engine cannot handle this delivery, so the
    // session controller may escalate the same source to managed output.
    case 'PIPELINE_FAILED':
      return 'unsupported-format';
    case 'INVALID_REQUEST':
      return 'prepare-failed';
    default:
      return fallback;
  }
}

function nativeOperationError(cause: unknown, fallback: PlayerErrorCode, message: string): PlayerOperationError {
  if (isWireError(cause)) {
    return new PlayerOperationError(playerErrorCodeFor(cause.code, fallback), cause.message, cause);
  }
  return new PlayerOperationError(fallback, message, cause);
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function hlsish(url: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(url);
}

function engineDuration(snapshot: NativeVideoSnapshot | undefined): number | null {
  return snapshot && !snapshot.live && snapshot.durationSeconds > 0
    ? snapshot.durationSeconds
    : null;
}

function hasEnded(snapshot: NativeVideoSnapshot | undefined): boolean {
  return Boolean(snapshot
    && !snapshot.live
    && snapshot.durationSeconds > 0
    && snapshot.currentTimeSeconds >= snapshot.durationSeconds);
}

function selectedCodec(snapshot: NativeVideoSnapshot, kind: 'video' | 'audio'): string | undefined {
  const track = snapshot.tracks.find(candidate => candidate.kind === kind && candidate.selected);
  return track && track.codec.length > 0 ? track.codec : undefined;
}

function sameLayout(a: NativeLayout | undefined, b: NativeLayout | undefined): boolean {
  return a !== undefined && b !== undefined
    && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function tracksFromNative(tracks: readonly NativeVideoTrack[]): PlayerTracks {
  const audio: PlayerTrack[] = [];
  const text: PlayerTrack[] = [];
  let selectedAudioId: string | null = null;
  let selectedTextId: string | null = null;
  for (const track of tracks) {
    if (track.kind !== 'audio' && track.kind !== 'subtitle') continue;
    const kind = track.kind === 'audio' ? 'audio' : 'text';
    const id = `${kind}:${track.index}`;
    const fallback = `${kind === 'audio' ? 'Audio' : 'Subtitle'} ${track.index}`;
    const entry: PlayerTrack = {
      id,
      label: [track.label, track.language].find(value => value.length > 0) ?? fallback,
      language: track.language.length > 0 ? track.language : undefined,
      available: true,
    };
    if (kind === 'audio') audio.push(entry); else text.push(entry);
    if (track.selected) {
      if (kind === 'audio') selectedAudioId = id; else selectedTextId = id;
    }
  }
  return { audio, text, selectedAudioId, selectedTextId };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The native engine keeps its own surface aligned with the anchor element: on
 * Linux the plugin places a GTK widget under a WebView aperture at the
 * element's CSS rectangle, so every layout change is forwarded through
 * native_layout and the DOM stack above the video is made transparent while a
 * native session is live.
 */
export class TauriNativeAdapter extends SessionPlayer {
  readonly capabilities = TAURI_NATIVE_PLAYER_CAPABILITIES;
  private readonly invoker: TauriVideoInvoker;
  private readonly platform: NativeVideoPlatform | undefined;
  private request?: OpenPlayerRequest;
  private sessionKey?: string;
  private native?: NativeVideoSnapshot;
  private requestedPlaying = false;
  private protocolVerified = false;
  private volume = 1;
  private muted = false;
  private timelineOffsetSeconds = 0;
  private timelineDurationSeconds: number | undefined;
  private adoptEngineDuration = false;
  private observedTitleDuration: number | null = null;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private firstFrameTimer?: ReturnType<typeof setTimeout>;
  private resizeObserver?: ResizeObserver;
  private aperture: Array<{ element: HTMLElement; background: string }> = [];
  private savedAnchorVisibility: string | undefined;
  private textureStream?: MediaStream;
  private lastLayout?: NativeLayout;
  private layoutDirty = false;
  private layoutInFlight = false;
  private layoutTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly anchor: HTMLVideoElement,
    invoker: TauriVideoInvoker = resolveTauriVideoInvoker(),
    options: { platform?: NativeVideoPlatform } = {},
  ) {
    super();
    this.invoker = invoker;
    this.platform = options.platform ?? tauriNativePlatform();
  }

  async open(request: OpenPlayerRequest): Promise<void> {
    await this.teardownNative();
    this.invalidateSession();
    const sessionId = this.startSession(request.kind);
    this.request = request;
    this.timelineOffsetSeconds = nonNegative(request.timelineOffsetSeconds ?? 0);
    this.timelineDurationSeconds = request.timelineDurationSeconds;
    this.adoptEngineDuration = request.adoptEngineDuration === true;
    this.observedTitleDuration = null;
    this.requestedPlaying = request.paused !== true;
    this.update(sessionId, {
      diagnostics: {
        engine: 'tauri-native',
        networkTransport: 'direct',
        transport: hlsish(request.url) ? 'hls' : 'file',
      },
      volume: { level: this.volume, muted: this.muted },
    });
    const sessionKey = newSessionKey();
    let established = false;
    try {
      const platform = this.requireNativePlatform();
      await this.verifyProtocol();
      if (!this.isCurrent(sessionId)) return;
      // Windows renders GStreamer D3D11 frames as a WebView2 texture stream on
      // the real video element; Linux places the native surface below the
      // WebView and hides the anchor element itself.
      let texture: Promise<MediaStream> | undefined;
      let textureBootstrap = false;
      if (platform === 'windows') {
        const api = webView2TextureStream();
        if (!api) {
          throw new PlayerOperationError(
            'engine-unavailable',
            'This WebView2 runtime does not expose GPU texture streams on the video element.',
          );
        }
        const streamId = await this.invoker.invoke<string>(`${COMMAND}native_prepare_texture_stream`, { sessionKey });
        if (!this.isCurrent(sessionId)) return;
        texture = api.getTextureStream(streamId);
        textureBootstrap = request.paused === true;
      }
      const layout = this.measureLayout();
      this.lastLayout = layout;
      const snapshot = await this.invoker.invoke<NativeVideoSnapshot>(`${COMMAND}native_open`, {
        payload: {
          protocolVersion: TAURI_VIDEO_PROTOCOL_VERSION,
          packageVersion: ADAPTER_PACKAGE_VERSION,
          sessionKey,
          uri: request.url,
          x: layout.x,
          y: layout.y,
          width: layout.width,
          height: layout.height,
          scrollX: 0,
          scrollY: 0,
          autoplay: texture !== undefined || this.requestedPlaying,
          volume: textureBootstrap ? 0 : this.volume,
          muted: this.muted,
          ...(request.authorization?.cookie ? { cookies: request.authorization.cookie } : {}),
          ...(request.authorization?.userAgent ? { userAgent: request.authorization.userAgent } : {}),
        },
      });
      if (!this.isCurrent(sessionId)) return;
      established = true;
      this.sessionKey = sessionKey;
      this.native = snapshot;
      if (texture) {
        this.textureStream = await texture;
        this.anchor.srcObject = this.textureStream;
        this.anchor.autoplay = true;
        this.anchor.playsInline = true;
        if (textureBootstrap) {
          // The stream becomes visible before the pipeline has prerolled; give
          // it a moment, then honor the paused request and start position.
          await delay(500);
          if (!this.isCurrent(sessionId)) return;
          this.acceptSnapshot(await this.control('pause'));
          this.acceptSnapshot(await this.control('seek', boundedPosition(request.startAtSeconds ?? 0, engineDuration(snapshot))));
          this.acceptSnapshot(await this.control('volume', this.muted ? 0 : this.volume));
        }
      } else {
        const startAt = boundedPosition(request.startAtSeconds ?? 0, engineDuration(snapshot));
        if (startAt > 0 && !snapshot.live) {
          this.acceptSnapshot(await this.control('seek', startAt));
        }
      }
      if (!this.isCurrent(sessionId)) return;
      this.publishSnapshot(sessionId, this.native);
      this.update(sessionId, { error: null });
      if (platform !== 'windows') this.openAperture();
      this.startLayoutTracking();
      this.startPolling();
      this.watchFirstFrame(sessionId, request);
      if (this.native.playing) this.update(sessionId, { state: 'playing' });
      else if (request.paused === true) this.update(sessionId, { state: 'paused' });
      else this.update(sessionId, { state: 'ready' });
    } catch (cause) {
      const error = cause instanceof PlayerOperationError
        ? cause
        : nativeOperationError(cause, 'connection-failed', 'The native video engine could not open the selected source.');
      this.fail(sessionId, error.toFailure());
      await this.teardownNative();
      throw error;
    } finally {
      // A session that never established must not keep a native engine attached.
      if (!established) await this.closeSession(sessionKey);
    }
  }

  async play(): Promise<void> {
    const sessionId = this.activeSessionOrThrow();
    this.requestedPlaying = true;
    try {
      const snapshot = this.acceptSnapshot(await this.control('play'));
      if (!this.isCurrent(sessionId)) return;
      this.publishSnapshot(sessionId, snapshot);
      this.update(sessionId, { state: 'playing', error: null });
    } catch (cause) {
      this.throwOperation(sessionId, 'prepare-failed', 'The native engine could not resume playback.', cause);
    }
  }

  async pause(): Promise<void> {
    const sessionId = this.activeSessionOrThrow();
    this.requestedPlaying = false;
    try {
      const snapshot = this.acceptSnapshot(await this.control('pause'));
      if (!this.isCurrent(sessionId)) return;
      this.publishSnapshot(sessionId, snapshot);
      this.update(sessionId, { state: 'paused' });
    } catch (cause) {
      this.throwOperation(sessionId, 'prepare-failed', 'The native engine could not pause playback.', cause);
    }
  }

  async seek(positionSeconds: number): Promise<void> {
    const sessionId = this.activeSessionOrThrow();
    if (this.request?.kind === 'live') {
      throw new PlayerOperationError('unsupported-operation', 'Live playback does not expose VOD seeking.');
    }
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
      throw new PlayerOperationError('seek-failed', 'Seek position must be a non-negative number.');
    }
    const native = this.native;
    if (native?.seekable === false) {
      throw new PlayerOperationError('unsupported-operation', 'The active media does not expose a seekable window.');
    }
    const duration = engineDuration(native);
    let target = boundedPosition(positionSeconds - this.timelineOffsetSeconds, duration);
    if (native) {
      const minimum = Math.max(0, native.seekableStartSeconds ?? 0);
      const maximum = native.seekableEndSeconds ?? duration ?? undefined;
      if (maximum !== undefined && Number.isFinite(maximum)) target = Math.min(target, Math.max(minimum, maximum));
      target = Math.max(target, minimum);
    }
    try {
      const snapshot = this.acceptSnapshot(await this.control('seek', target));
      if (!this.isCurrent(sessionId)) return;
      this.publishSnapshot(sessionId, snapshot);
    } catch (cause) {
      this.throwOperation(sessionId, 'seek-failed', 'The native engine could not seek the selected source.', cause);
    }
  }

  async setVolume(level: number): Promise<void> {
    this.volume = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 1));
    if (this.volume > 0) this.muted = false;
    await this.applyVolume();
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    await this.applyVolume();
  }

  async stop(): Promise<void> {
    this.invalidateSession();
    await this.teardownNative();
    this.terminal('stopped');
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.terminal('disposed');
  }

  async selectAudioTrack(trackId: string): Promise<void> {
    const sessionId = this.activeSessionOrThrow();
    const index = this.trackIndex('audio', trackId);
    try {
      const snapshot = this.acceptSnapshot(await this.control('track', 0, index));
      if (!this.isCurrent(sessionId)) return;
      this.publishSnapshot(sessionId, snapshot);
    } catch (cause) {
      this.throwOperation(sessionId, 'unsupported-operation', `The native engine could not select audio track ${trackId}.`, cause);
    }
  }

  async selectTextTrack(trackId: string | null): Promise<void> {
    const sessionId = this.activeSessionOrThrow();
    if (trackId === null) {
      const active = this.native?.tracks.find(track => track.kind === 'subtitle' && track.selected);
      if (!active) {
        this.update(sessionId, { tracks: { ...this.snapshot.tracks, selectedTextId: null } });
        return;
      }
      try {
        const snapshot = this.acceptSnapshot(await this.control('deselectTrack', 0, active.index));
        if (!this.isCurrent(sessionId)) return;
        this.publishSnapshot(sessionId, snapshot);
      } catch (cause) {
        this.throwOperation(sessionId, 'unsupported-operation', 'The native engine could not disable subtitles.', cause);
      }
      return;
    }
    const index = this.trackIndex('text', trackId);
    try {
      const snapshot = this.acceptSnapshot(await this.control('track', 0, index));
      if (!this.isCurrent(sessionId)) return;
      this.publishSnapshot(sessionId, snapshot);
    } catch (cause) {
      this.throwOperation(sessionId, 'unsupported-operation', `The native engine could not select subtitle track ${trackId}.`, cause);
    }
  }

  private requireNativePlatform(): NativeVideoPlatform {
    if (this.platform !== 'linux' && this.platform !== 'windows') {
      throw new PlayerOperationError(
        'engine-unavailable',
        'Native video playback is supported on the Linux and Windows desktop builds.',
      );
    }
    return this.platform;
  }

  /** The JS/Rust wire contract is verified before any stateful command runs. */
  private async verifyProtocol(): Promise<void> {
    if (this.protocolVerified) return;
    let diagnostics: NativeVideoDiagnostics | undefined;
    try {
      diagnostics = await this.invoker.invoke<NativeVideoDiagnostics>(`${COMMAND}native_diagnostics`);
    } catch (cause) {
      throw new PlayerOperationError(
        'engine-unavailable',
        'The native video plugin did not answer its diagnostics command.',
        cause,
      );
    }
    if (!diagnostics || diagnostics.protocolVersion !== TAURI_VIDEO_PROTOCOL_VERSION) {
      const actual = diagnostics && typeof diagnostics.protocolVersion === 'number'
        ? diagnostics.protocolVersion
        : 'unknown';
      throw new PlayerOperationError(
        'engine-unavailable',
        `The native video plugin reports protocol ${actual}; this adapter requires ${TAURI_VIDEO_PROTOCOL_VERSION}. Update the desktop app and tauri-plugin-video together.`,
      );
    }
    this.protocolVerified = true;
  }

  private async control(action: string, value = 0, index = -1): Promise<NativeVideoSnapshot> {
    const sessionKey = this.sessionKey;
    if (sessionKey === undefined) {
      throw new PlayerOperationError('invalid-state', 'No active native playback session.');
    }
    return this.invoker.invoke<NativeVideoSnapshot>(`${COMMAND}native_control`, {
      payload: { sessionKey, action, value, index },
    });
  }

  private acceptSnapshot(snapshot: NativeVideoSnapshot): NativeVideoSnapshot {
    this.native = snapshot;
    return snapshot;
  }

  private publishSnapshot(sessionId: number, snapshot: NativeVideoSnapshot): void {
    if ((snapshot.videoWidth ?? 0) > 0) this.clearFirstFrameWatchdog();
    this.update(sessionId, {
      time: this.time(snapshot),
      tracks: tracksFromNative(snapshot.tracks),
      diagnostics: this.snapshot.diagnostics
        ? {
          ...this.snapshot.diagnostics,
          videoCodec: selectedCodec(snapshot, 'video'),
          audioCodec: selectedCodec(snapshot, 'audio'),
          width: snapshot.videoWidth,
          height: snapshot.videoHeight,
        }
        : undefined,
    });
  }

  /** The seek bar's length: the server total, raised only by an original file. */
  private time(snapshot: NativeVideoSnapshot): PlayerTime {
    const position = this.timelineOffsetSeconds + Math.max(0, snapshot.currentTimeSeconds);
    const duration = engineDuration(snapshot);
    const engine = duration !== null ? duration + this.timelineOffsetSeconds : null;
    const next = timelineDuration(this.timelineDurationSeconds, engine, this.adoptEngineDuration);
    this.observedTitleDuration = growOnlyDuration(this.observedTitleDuration, next);
    const lead = snapshot.bufferedSeconds - snapshot.currentTimeSeconds;
    const bufferedEnd = snapshot.live || lead <= 0
      ? null
      : Math.min(
        snapshot.bufferedSeconds + this.timelineOffsetSeconds,
        this.observedTitleDuration ?? Number.POSITIVE_INFINITY,
      );
    return {
      positionSeconds: position,
      durationSeconds: this.observedTitleDuration,
      bufferedEndSeconds: bufferedEnd,
    };
  }

  private async applyVolume(): Promise<void> {
    const sessionId = this.snapshot.sessionId;
    if (this.sessionKey === undefined) {
      this.update(sessionId, { volume: { level: this.volume, muted: this.muted } });
      return;
    }
    try {
      this.acceptSnapshot(await this.control('volume', this.muted ? 0 : this.volume));
      if (!this.isCurrent(sessionId)) return;
      this.update(sessionId, { volume: { level: this.volume, muted: this.muted } });
    } catch (cause) {
      this.throwOperation(sessionId, 'prepare-failed', 'The native engine could not change the volume.', cause);
    }
  }

  private trackIndex(kind: 'audio' | 'text', trackId: string): number {
    const nativeKind = kind === 'audio' ? 'audio' : 'subtitle';
    const track = this.native?.tracks.find(
      candidate => candidate.kind === nativeKind && `${kind}:${candidate.index}` === trackId,
    );
    if (!track) {
      throw new PlayerOperationError(
        'unsupported-operation',
        `${kind === 'audio' ? 'Audio' : 'Subtitle'} track ${trackId} is not available.`,
      );
    }
    return track.index;
  }

  private throwOperation(sessionId: number, code: PlayerErrorCode, message: string, cause: unknown): never {
    const error = cause instanceof PlayerOperationError
      ? cause
      : nativeOperationError(cause, code, message);
    this.fail(sessionId, error.toFailure());
    throw error;
  }

  private startPolling(): void {
    this.stopPolling();
    this.schedulePoll(0);
  }

  private schedulePoll(delayMs: number): void {
    if (this.pollTimer !== undefined || this.sessionKey === undefined) return;
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = undefined;
      await this.poll();
      if (this.sessionKey !== undefined) {
        this.schedulePoll(this.requestedPlaying ? 250 : 1000);
      }
    }, delayMs);
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async poll(): Promise<void> {
    const sessionKey = this.sessionKey;
    if (sessionKey === undefined) return;
    const sessionId = this.snapshot.sessionId;
    try {
      const snapshot = await this.invoker.invoke<NativeVideoSnapshot>(`${COMMAND}native_stats`, {
        payload: { sessionKey },
      });
      if (this.sessionKey !== sessionKey || !this.isCurrent(sessionId)) return;
      const previous = this.native;
      this.publishSnapshot(sessionId, snapshot);
      if (previous && previous.playing !== snapshot.playing) {
        this.update(sessionId, { state: snapshot.playing ? 'playing' : 'paused' });
      }
      if (!hasEnded(previous) && hasEnded(snapshot)) {
        this.requestedPlaying = false;
        this.update(sessionId, { state: 'ended' });
      }
    } catch (cause) {
      if (!this.isCurrent(sessionId)) return;
      const error = nativeOperationError(cause, 'connection-failed', 'Native playback statistics became unavailable.');
      this.fail(sessionId, error.toFailure());
      this.stopPolling();
    }
  }

  private measureLayout(): NativeLayout {
    const rect = this.anchor.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
  }

  private startLayoutTracking(): void {
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.requestLayout());
      this.resizeObserver.observe(this.anchor);
    }
    window.addEventListener('resize', this.handleViewportChange, { passive: true });
    window.addEventListener('scroll', this.handleViewportChange, { capture: true, passive: true });
    this.requestLayout();
  }

  private stopLayoutTracking(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    window.removeEventListener('resize', this.handleViewportChange);
    window.removeEventListener('scroll', this.handleViewportChange, true);
    if (this.layoutTimer !== undefined) {
      clearTimeout(this.layoutTimer);
      this.layoutTimer = undefined;
    }
    this.layoutDirty = false;
    this.layoutInFlight = false;
  }

  private handleViewportChange = (): void => this.requestLayout();

  private requestLayout(): void {
    if (this.sessionKey === undefined) return;
    this.layoutDirty = true;
    if (this.layoutTimer !== undefined || this.layoutInFlight) return;
    // One frame of batching keeps bursty resize/scroll from crossing IPC; the
    // Rust side serializes native_layout so the host aperture stays aligned.
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = undefined;
      void this.flushLayout();
    }, 16);
  }

  private async flushLayout(): Promise<void> {
    const sessionKey = this.sessionKey;
    if (sessionKey === undefined || this.layoutInFlight || !this.layoutDirty) return;
    this.layoutInFlight = true;
    try {
      this.layoutDirty = false;
      const layout = this.measureLayout();
      if (sameLayout(layout, this.lastLayout)) return;
      await this.invoker.invoke(`${COMMAND}native_layout`, {
        payload: { sessionKey, x: layout.x, y: layout.y, width: layout.width, height: layout.height },
      });
      if (this.sessionKey !== sessionKey) return;
      this.lastLayout = layout;
      this.publishLayoutVariables(layout);
    } catch (cause) {
      const sessionId = this.snapshot.sessionId;
      if (this.isCurrent(sessionId)) {
        const error = nativeOperationError(cause, 'connection-failed', 'The native video surface could not follow its layout.');
        this.fail(sessionId, error.toFailure());
      }
    } finally {
      this.layoutInFlight = false;
      if (this.layoutDirty && this.sessionKey !== undefined) this.requestLayout();
    }
  }

  /**
   * Makes the DOM stack above the anchor transparent so the native surface
   * shows through the WebView aperture, and hides the anchor itself. This is
   * the honest MVP aperture: unlike the plugin's own compositor it does not
   * reconstruct the original backgrounds around the video rectangle, so the
   * surrounding page shows the native black floor while a session is live.
   */
  private openAperture(): void {
    if (this.savedAnchorVisibility === undefined) {
      this.savedAnchorVisibility = this.anchor.style.visibility;
      this.anchor.style.visibility = 'hidden';
    }
    const saved: Array<{ element: HTMLElement; background: string }> = [];
    for (let element = this.anchor.parentElement; element instanceof HTMLElement; element = element.parentElement) {
      saved.push({ element, background: element.style.background });
      element.style.background = 'transparent';
    }
    this.aperture = saved;
    if (this.lastLayout) this.publishLayoutVariables(this.lastLayout);
  }

  private closeAperture(): void {
    for (const { element, background } of this.aperture) element.style.background = background;
    this.aperture = [];
    if (this.savedAnchorVisibility !== undefined) {
      this.anchor.style.visibility = this.savedAnchorVisibility;
      this.savedAnchorVisibility = undefined;
    }
    const root = document.documentElement;
    root.classList.remove('tauri-native-video');
    for (const name of LAYOUT_VARIABLES) root.style.removeProperty(name);
  }

  private publishLayoutVariables(layout: NativeLayout): void {
    const root = document.documentElement;
    root.classList.add('tauri-native-video');
    root.style.setProperty('--tauri-native-video-left', `${layout.x}px`);
    root.style.setProperty('--tauri-native-video-top', `${layout.y}px`);
    root.style.setProperty('--tauri-native-video-right', `${layout.x + layout.width}px`);
    root.style.setProperty('--tauri-native-video-bottom', `${layout.y + layout.height}px`);
    root.style.setProperty('--tauri-native-video-width', `${layout.width}px`);
    root.style.setProperty('--tauri-native-video-height', `${layout.height}px`);
  }

  private releaseTextureStream(): void {
    const stream = this.textureStream;
    this.textureStream = undefined;
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (stream) {
      try { if (this.anchor.srcObject === stream) this.anchor.srcObject = null; } catch { /* already detached */ }
    }
  }

  private watchFirstFrame(sessionId: number, request: OpenPlayerRequest): void {
    if (request.expectedVideo === false || (this.native?.videoWidth ?? 0) > 0 || this.firstFrameTimer) return;
    this.firstFrameTimer = setTimeout(() => {
      this.firstFrameTimer = undefined;
      if (!this.isCurrent(sessionId) || (this.native?.videoWidth ?? 0) > 0 || this.snapshot.state === 'error') return;
      this.fail(sessionId, { code: 'unsupported-format', message: 'The native engine did not produce a decoded video frame.' });
    }, FIRST_FRAME_TIMEOUT_MS);
  }

  private clearFirstFrameWatchdog(): void {
    if (this.firstFrameTimer !== undefined) {
      clearTimeout(this.firstFrameTimer);
      this.firstFrameTimer = undefined;
    }
  }

  private async closeSession(sessionKey: string): Promise<void> {
    await this.invoker
      .invoke(`${COMMAND}native_close`, { payload: { sessionKey } })
      .catch(() => undefined);
  }

  private async teardownNative(): Promise<void> {
    this.stopPolling();
    this.clearFirstFrameWatchdog();
    this.stopLayoutTracking();
    this.closeAperture();
    this.releaseTextureStream();
    const sessionKey = this.sessionKey;
    this.sessionKey = undefined;
    this.native = undefined;
    this.request = undefined;
    this.requestedPlaying = false;
    this.lastLayout = undefined;
    if (sessionKey !== undefined) await this.closeSession(sessionKey);
  }
}
