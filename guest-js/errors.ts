import { Schema } from 'effect'

import {
  VIDEO_PLAYER_ERROR_MARKER,
  type RegisteredVideoPlayerError,
} from './index'

export class VideoBackendUnavailableError extends Schema.TaggedError<VideoBackendUnavailableError>()(
  'VideoBackendUnavailableError',
  {
    backend: Schema.String,
    message: Schema.String,
  },
) {}

export class VideoFeatureUnavailableError extends Schema.TaggedError<VideoFeatureUnavailableError>()(
  'VideoFeatureUnavailableError',
  {
    backend: Schema.String,
    feature: Schema.String,
    message: Schema.String,
  },
) {}

export class VideoLoadError extends Schema.TaggedError<VideoLoadError>()(
  'VideoLoadError',
  {
    backend: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.String),
  },
) {}

export class VideoControllerStateError extends Schema.TaggedError<VideoControllerStateError>()(
  'VideoControllerStateError',
  {
    backend: Schema.String,
    state: Schema.Literal('loading', 'load-failed', 'destroyed'),
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.String),
  },
) {}

export type VideoPlayerError =
  | VideoBackendUnavailableError
  | VideoFeatureUnavailableError
  | VideoLoadError
  | VideoControllerStateError
  | RegisteredVideoPlayerError

/** Canonical message extraction shared by the controller and the Effect layer. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** True for a built-in player error or an explicitly marked adapter error. */
export function isVideoPlayerError(error: unknown): error is VideoPlayerError {
  if (error instanceof VideoBackendUnavailableError
    || error instanceof VideoControllerStateError
    || error instanceof VideoFeatureUnavailableError
    || error instanceof VideoLoadError) return true
  if (!(error instanceof Error)) return false
  const candidate = error as Error & Record<PropertyKey, unknown>
  return candidate[VIDEO_PLAYER_ERROR_MARKER] === true
    && typeof candidate._tag === 'string'
    && candidate._tag.length > 0
}
