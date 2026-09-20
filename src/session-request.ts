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

export function adapterRequest(session: PlaybackSessionView, kind: PlaybackKind, position: number, paused: boolean): Parameters<Player['open']>[0] {
  const direct = session.mode === 'direct';
  const deliveryStart = direct ? 0 : Math.max(0, session.position);
  return {
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
    paused,
    authorization: session.authorization,
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
 * Only a network failure (0) or the server's delivery refusal (406) escalates;
 * validation (400) and every other answer keeps its own meaning.
 */
export function escalatePreparation(request: PlaybackStart, error: unknown): PlaybackStart | undefined {
  const status = refusalStatus(error);
  if (status !== 0 && status !== 406) return undefined;
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
  if (code !== 'unsupported-format') return undefined;
  if (session.mode === 'direct' && !request.managedOnly)
    return { ...request, managedOnly: true };
  if (session.mode !== 'direct' && !request.forceTranscode)
    return { ...request, managedOnly: true, forceTranscode: true };
  return undefined;
}
