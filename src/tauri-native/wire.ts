import {
  PlayerOperationError,
  type PlayerDiagnostics,
  type PlayerErrorCode,
  type PlayerTrack,
  type PlayerTracks,
} from '../types';
import type { NativeLayout } from './aperture';
import type { NativeVideoSnapshot, NativeVideoTrack, NativeWireError } from './types';

let nativeSessionSequence = 0;

interface WebView2TextureStreamApi {
  getTextureStream(streamId: string): Promise<MediaStream>;
}

export function webView2TextureStream(): WebView2TextureStreamApi | undefined {
  const scope = globalThis as typeof globalThis & {
    chrome?: { webview?: Partial<WebView2TextureStreamApi> };
  };
  const getTextureStream = scope.chrome?.webview?.getTextureStream;
  return typeof getTextureStream === 'function'
    ? { getTextureStream: getTextureStream.bind(scope.chrome?.webview) }
    : undefined;
}

export function newSessionKey(): string {
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
    case 'PIPELINE_FAILED':
    case 'SOURCE_OPEN_FAILED':
      return 'prepare-failed';
    // Only explicit media/decoder failures justify delivery conversion.
    case 'DECODE_FAILED':
    case 'MEDIA_FORMAT_FAILED':
      return 'unsupported-format';
    case 'VIDEO_OUTPUT_FAILED':
    case 'AUDIO_OUTPUT_FAILED':
      return 'engine-unavailable';
    case 'PROTECTED_MEDIA': return 'authorization-unsupported';
    case 'AUTHORIZATION_FAILED': return 'authorization-failed';
    case 'CONNECTION_FAILED': return 'connection-failed';
    case 'SOURCE_UNAVAILABLE': return 'expired-source';
    case 'INVALID_REQUEST':
      return 'prepare-failed';
    default:
      return fallback;
  }
}

export function nativeOperationError(cause: unknown, fallback: PlayerErrorCode, message: string): PlayerOperationError {
  if (isWireError(cause)) {
    // Older plugin builds mislabeled all pipeline failures as decoder errors.
    // Keep the caller's operation context for that ambiguous legacy code.
    return new PlayerOperationError(playerErrorCodeFor(cause.code, fallback),
      cause.code === 'PIPELINE_FAILED' ? message : cause.message, cause);
  }
  return new PlayerOperationError(fallback, message, cause);
}

function hlsish(url: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(url);
}

export function nativeDiagnostics(url: string, backend?: string): PlayerDiagnostics {
  return {
    engine: 'tauri-native',
    networkTransport: 'direct',
    transport: hlsish(url) ? 'hls' : 'file',
    ...(backend && backend.length > 0 ? { backend } : {}),
  };
}

export function engineDuration(snapshot: NativeVideoSnapshot | undefined): number | null {
  return snapshot && !snapshot.live && snapshot.durationSeconds > 0
    ? snapshot.durationSeconds
    : null;
}

export function hasEnded(snapshot: NativeVideoSnapshot | undefined): boolean {
  return Boolean(snapshot
    && !snapshot.live
    && snapshot.durationSeconds > 0
    && snapshot.currentTimeSeconds >= snapshot.durationSeconds);
}

export function selectedCodec(snapshot: NativeVideoSnapshot, kind: 'video' | 'audio'): string | undefined {
  const track = snapshot.tracks.find(candidate => candidate.kind === kind && candidate.selected);
  return track && track.codec.length > 0 ? track.codec : undefined;
}

export function sameLayout(a: NativeLayout | undefined, b: NativeLayout | undefined): boolean {
  return a !== undefined && b !== undefined
    && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function tracksFromNative(tracks: readonly NativeVideoTrack[]): PlayerTracks {
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
