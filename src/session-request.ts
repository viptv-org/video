import { canChangeMediaPath } from './browser-policy';
import type {
  PlaybackBackendError,
  PlaybackCapabilities,
  PlaybackKind,
  PlaybackSessionView,
  PlaybackStart,
  Player,
  PlayerFailure,
} from './types';
import type { PlaybackControllerState, PlaybackIntentItem, SessionStartIntent } from './session';

export function playbackRequest(intent: SessionStartIntent, capabilities: PlaybackCapabilities, position: number): PlaybackStart {
  if (intent.item.type === 'live') return { channelId: intent.item.id, position, capabilities };
  if (!intent.source) throw new Error('VOD playback requires an explicit source.');
  return { streamId: intent.source.id, position, capabilities };
}

export function isOriginalDelivery(session: PlaybackSessionView): boolean {
  return session.deliveryKind ? session.deliveryKind === 'direct' : session.mode === 'direct';
}

export function adapterRequest(session: PlaybackSessionView, kind: PlaybackKind, position: number, paused: boolean): Parameters<Player['open']>[0] {
  const direct = isOriginalDelivery(session);
  const deliveryStart = direct ? 0 : Math.max(0, session.position);
  return {
    preferredAudioLanguage: session.preferredAudioLanguage,
    preferredSubtitleLanguage: session.preferredSubtitleLanguage,
    maximumHeight: session.maximumHeight,
    url: session.url,
    kind,
    startAtSeconds: direct ? position : Math.max(0, position - deliveryStart),
    timelineOffsetSeconds: deliveryStart,
    // A managed delivery is a rolling window; only the session knows how long
    // the title is. Direct original files may refine it with their own length.
    timelineDurationSeconds: kind === 'live' || !(session.duration > 0) ? undefined : session.duration,
    adoptEngineDuration: direct,
    deliveryMode: direct ? 'direct' : 'managed',
    deliveryFormat: session.format,
    deliveryDecision: ['encode', 'transcode'].includes(session.videoMode) ? 'video-conversion'
      : ['encode', 'transcode'].includes(session.audioMode) ? 'audio-conversion' : direct ? 'original' : 'server-remux',
    paused,
    authorization: direct ? session.authorization : undefined,
  };
}

export function itemKind(item: PlaybackIntentItem): PlaybackKind {
  return item.type === 'live' ? 'live' : 'vod';
}

export function playerState(player: Player): Extract<PlaybackControllerState, 'playing' | 'opening' | 'error'> {
  return player.snapshot.state === 'paused' ? 'playing' : player.snapshot.state === 'error' ? 'error' : 'playing';
}

export function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error('Playback operation failed.');
}

/** The playback port reports refusals as Errors carrying an HTTP-like status. */
function refusalStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const { status } = error as Partial<PlaybackBackendError>;
  return typeof status === 'number' ? status : undefined;
}

/**
 * A delivery refusal is answered with the next delivery rung for the same
 * source: original delivery, then managed output, then a forced transcode.
 * Only a server delivery refusal (406) escalates; network failures never encode media.
 * validation (400) and every other answer keeps its own meaning.
 */
export function escalatePreparation(request: PlaybackStart, error: unknown): PlaybackStart | undefined {
  const status = refusalStatus(error);
  if (status !== 406) return undefined;
  if (!request.managedOnly) return { ...request, managedOnly: true };
  if (!request.forceTranscode) return { ...request, managedOnly: true, forceTranscode: true };
  return undefined;
}

/** Keep the selected source while escalating only after the cheaper rung fails. */
export function recoveryRequest(
  session: PlaybackSessionView,
  request: PlaybackStart,
  code: PlayerFailure['code'],
): PlaybackStart | undefined {
  // A direct media origin may be unreachable from this client (for example
  // browser CORS). Try the authorized gateway once without forcing conversion.
  // A control-API outage or a failure of managed delivery never takes this path.
  if (code === 'connection-failed' && isOriginalDelivery(session) && !request.managedOnly)
    return { ...request, managedOnly: true };
  if (!canChangeMediaPath({ code })) return undefined;
  if (isOriginalDelivery(session) && !request.managedOnly)
    return { ...request, managedOnly: true };
  if (!isOriginalDelivery(session) && !request.forceTranscode)
    return { ...request, managedOnly: true, forceTranscode: true };
  return undefined;
}
