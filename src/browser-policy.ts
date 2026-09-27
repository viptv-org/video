import { PlayerOperationError, type PlayerFailure, type MediaFailureReason } from './types';

let policy = { clientInspection: false, localRemux: false };
/** Rollout switches are supplied by the host, never inferred from user agent. */
export function configureBrowserPlayback(value: Partial<typeof policy>): void { policy = { ...policy, ...value }; }
export function browserPlaybackPolicy(): Readonly<typeof policy> { return policy; }
export function mediaFailure(cause: unknown, reason: MediaFailureReason = 'container'): PlayerOperationError {
  if (cause instanceof PlayerOperationError) return cause;
  if (cause instanceof DOMException && cause.name === 'NotAllowedError')
    return new PlayerOperationError('autoplay-blocked', 'Select Play to enable playback.', undefined, 'autoplay');
  if (cause instanceof TypeError)
    return new PlayerOperationError('connection-failed', 'Media could not be read. Retry playback.', undefined, 'network');
  return new PlayerOperationError('unsupported-format', 'This playback path cannot present the selected media.', undefined, reason);
}
export function canChangeMediaPath(failure: Pick<PlayerFailure, 'code' | 'reason'>): boolean {
  return ['unsupported-format', 'engine-unavailable', 'performance-limited'].includes(failure.code)
    && !['network', 'authorization', 'autoplay'].includes(failure.reason ?? '');
}
