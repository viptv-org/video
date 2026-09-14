import type { HttpTransport } from '@get-air/http'
import { parse } from '@plussub/srt-vtt-parser'
import { Cause, Effect, Exit, Option } from 'effect'

import {
  errorMessage,
  isVideoPlayerError,
  VideoControllerStateError,
  VideoLoadError,
  type VideoPlayerError,
} from './errors'
import { VideoEventTarget } from './events'
import type {
  AttachVideoOptions,
  BackendVideoController,
  ExternalSubtitleTrack,
  MediaInfo,
  MediaTrack,
  PlaybackQuality,
  PlayerCapabilities,
  SessionStats,
  SubtitleCue,
  TrackKind,
  VideoController,
  VideoControllerEventMap,
  VideoControlsTarget,
  VideoBackendId,
  VideoFitMode,
  VideoLoadOptions,
  VideoSource,
} from './index'

type AttachBackend = (
  options: AttachVideoOptions,
) => Effect.Effect<BackendVideoController, VideoPlayerError>
type ControllerState = 'active' | 'loading' | 'load-failed' | 'destroyed'

interface ControllerMetadata {
  generation: number
  sourceCapabilities: PlayerCapabilities
  sourceTracks: readonly MediaTrack[]
  capabilities: PlayerCapabilities
  media: MediaInfo
  tracks: readonly MediaTrack[]
}

/**
 * Stable public controller that can replace its backend without replacing UI
 * references or event subscriptions. Backend instances remain intentionally
 * private so every load follows the same Effect-backed selection path.
 */
export class SwitchingVideoController extends VideoEventTarget implements VideoController {
  readonly element: HTMLVideoElement
  #active: BackendVideoController | undefined
  #options: AttachVideoOptions
  readonly #attach: AttachBackend
  readonly #defaultTransport: HttpTransport
  readonly #loadSemaphore = Effect.unsafeMakeSemaphore(1)
  #state: ControllerState = 'active'
  #stateCause: string | undefined
  #lastBackend: VideoBackendId
  #unsubscribe: Array<() => void> = []
  #subtitleTrack?: ExternalSubtitleTrack
  #subtitleCues: readonly SubtitleCue[] = []
  #visibleCues: readonly SubtitleCue[] = []
  #abortSignal?: AbortSignal
  #metadataGeneration = 0
  #metadata?: ControllerMetadata

  constructor(
    active: BackendVideoController,
    options: AttachVideoOptions,
    attach: AttachBackend,
    transport: HttpTransport,
  ) {
    super()
    this.element = active.element
    this.#active = active
    this.#lastBackend = active.capabilities.backend
    this.#options = options
    this.#attach = attach
    this.#defaultTransport = transport
    this.#forwardEvents(active)
    this.#bindAbortSignal(options.signal)
  }

  readonly initializeEffect = Effect.fn('SwitchingVideoController.initialize')(() => {
    const initialSubtitle = this.#options.subtitles?.find((track) => track.default)
    if (!initialSubtitle) return Effect.void
    return Effect.promise(() => this.#selectExternalSubtitle(
      this.#requireActive('select the default subtitle'),
      initialSubtitle,
    ).catch((cause) => this.#publishSubtitleError(initialSubtitle.id, cause)))
  })

  readonly sessionIdEffect = Effect.fn('SwitchingVideoController.sessionId')(
    () => this.#readActive('read the session ID', (active) => active.sessionId),
  )

  readonly capabilitiesEffect = Effect.fn('SwitchingVideoController.capabilities')(
    () => this.#readActive('read capabilities', (active) => this.#readMetadata(active).capabilities),
  )

  readonly mediaEffect = Effect.fn('SwitchingVideoController.media')(
    () => this.#readActive('read media information', (active) => this.#readMetadata(active).media),
  )

  readonly tracksEffect = Effect.fn('SwitchingVideoController.tracks')(
    () => this.#readActive('read tracks', (active) => this.#readMetadata(active).tracks),
  )

  get sessionId(): string { return runVideoEffectSync(this.sessionIdEffect()) }

  get capabilities(): PlayerCapabilities {
    return runVideoEffectSync(this.capabilitiesEffect())
  }

  get media(): MediaInfo {
    return runVideoEffectSync(this.mediaEffect())
  }

  get tracks(): readonly MediaTrack[] {
    return runVideoEffectSync(this.tracksEffect())
  }

  readonly playEffect = this.#promiseOperation(
    'SwitchingVideoController.play', 'play video', (active) => active.play())
  readonly pauseEffect = this.#syncOperation(
    'SwitchingVideoController.pause', 'pause video', (active) => active.pause())
  readonly seekEffect = this.#promiseOperation(
    'SwitchingVideoController.seek', 'seek video', (active, position: number) => active.seek(position))
  readonly selectTrackEffect = this.#promiseOperation(
    'SwitchingVideoController.selectTrack', 'select a track',
    (active, kind: TrackKind, id?: string) => this.#selectTrack(active, kind, id))
  readonly setVolumeEffect = this.#promiseOperation(
    'SwitchingVideoController.setVolume', 'set volume',
    (active, volume: number) => active.setVolume(volume))
  readonly setPlaybackRateEffect = this.#promiseOperation(
    'SwitchingVideoController.setPlaybackRate', 'set playback rate',
    (active, rate: number) => active.setPlaybackRate(rate))
  readonly setVideoFitEffect = this.#promiseOperation(
    'SwitchingVideoController.setVideoFit', 'set video fit',
    (active, mode: VideoFitMode) => active.setVideoFit(mode))
  readonly setVideoZoomEffect = this.#promiseOperation(
    'SwitchingVideoController.setVideoZoom', 'set video zoom',
    (active, scale: number) => active.setVideoZoom(scale))
  readonly statsEffect = this.#promiseOperation(
    'SwitchingVideoController.stats', 'read video statistics', (active) => active.stats())
  readonly bufferedAheadEffect = this.#syncOperation(
    'SwitchingVideoController.bufferedAhead', 'read buffered duration',
    (active) => active.bufferedAhead())
  readonly playbackQualityEffect = this.#syncOperation(
    'SwitchingVideoController.playbackQuality', 'read playback quality',
    (active) => active.playbackQuality())
  readonly refreshLayoutEffect = this.#syncOperation(
    'SwitchingVideoController.refreshLayout', 'refresh video layout',
    (active) => active.refreshLayout())
  readonly registerControlsEffect = this.#syncOperation(
    'SwitchingVideoController.registerControls', 'register video controls',
    (active, target: VideoControlsTarget) => active.registerControls(target))

  play(): Promise<void> { return runVideoEffectPromise(this.playEffect()) }
  pause(): void { runVideoEffectSync(this.pauseEffect()) }
  seek(positionSeconds: number): Promise<void> {
    return runVideoEffectPromise(this.seekEffect(positionSeconds))
  }
  setVolume(volume: number): Promise<void> {
    return runVideoEffectPromise(this.setVolumeEffect(volume))
  }
  setPlaybackRate(rate: number): Promise<void> {
    return runVideoEffectPromise(this.setPlaybackRateEffect(rate))
  }
  setVideoFit(mode: VideoFitMode): Promise<void> {
    return runVideoEffectPromise(this.setVideoFitEffect(mode))
  }
  setVideoZoom(scale: number): Promise<void> {
    return runVideoEffectPromise(this.setVideoZoomEffect(scale))
  }
  stats(): Promise<SessionStats> { return runVideoEffectPromise(this.statsEffect()) }
  bufferedAhead(): number { return runVideoEffectSync(this.bufferedAheadEffect()) }
  playbackQuality(): PlaybackQuality {
    return runVideoEffectSync(this.playbackQualityEffect())
  }
  refreshLayout(): void { runVideoEffectSync(this.refreshLayoutEffect()) }
  registerControls(target: VideoControlsTarget): () => void {
    return runVideoEffectSync(this.registerControlsEffect(target))
  }

  /**
   * Replaces the current source. `backend` may be a single value or an ordered
   * chain such as `['html', 'native-surface']`; other omitted options are retained.
   */
  load(source: string | VideoSource, options: VideoLoadOptions = {}): Promise<void> {
    return runVideoEffectPromise(this.loadEffect(source, options))
  }

  readonly loadEffect = Effect.fn('SwitchingVideoController.load')(
    (source: string | VideoSource, options: VideoLoadOptions = {}) => {
      const controller = this
      const replace = Effect.gen(function* () {
        if (controller.#state === 'destroyed') {
          return yield* controller.#stateError('load video')
        }
        const nextOptions: AttachVideoOptions = { ...controller.#options, ...options, source }
        controller.#bindAbortSignal(nextOptions.signal)
        const previous = controller.#active
        const previousBackend = controller.#lastBackend
        controller.#state = 'loading'
        controller.#stateCause = undefined
        controller.#stopForwarding()
        controller.#active = undefined
        if (previous) {
          yield* Effect.tryPromise({
            try: () => previous.destroy(),
            catch: (cause) => nextOptions.signal?.aborted
              ? controller.#abortLoad(nextOptions.signal, 'destroy the previous backend')
              : controller.#transitionFailure(
                'load-failed',
                'destroy the previous backend',
                cause,
              ),
          })
        }
        const active = yield* controller.#attach(nextOptions).pipe(
          Effect.tapError((cause) => Effect.sync(() => {
            if (nextOptions.signal?.aborted) {
              controller.#abortLoad(nextOptions.signal, 'load video')
            } else {
              controller.#markLoadFailed(cause)
            }
          })),
        )
        if (nextOptions.signal?.aborted) {
          yield* Effect.tryPromise({
            try: () => active.destroy(),
            catch: () => undefined,
          }).pipe(Effect.ignore)
          return yield* controller.#abortLoad(nextOptions.signal, 'load video')
        }
        controller.#active = active
        controller.#lastBackend = active.capabilities.backend
        controller.#options = nextOptions
        controller.#subtitleTrack = undefined
        controller.#subtitleCues = []
        controller.#visibleCues = []
        controller.#invalidateMetadata()
        controller.#state = 'active'
        controller.#stateCause = undefined
        controller.#forwardEvents(active)
        const defaultSubtitle = nextOptions.subtitles?.find((track) => track.default)
        if (defaultSubtitle) {
          yield* Effect.promise(() => controller.#selectExternalSubtitle(active, defaultSubtitle)
            .catch((cause) => controller.#publishSubtitleError(defaultSubtitle.id, cause)))
        }
        if (nextOptions.signal?.aborted) {
          controller.#active = undefined
          controller.#stopForwarding()
          yield* Effect.tryPromise({
            try: () => active.destroy(),
            catch: () => undefined,
          }).pipe(Effect.ignore)
          return yield* controller.#abortLoad(nextOptions.signal, 'load video')
        }
        controller.dispatchEvent(new CustomEvent('backendchange', {
          detail: { previousBackend, backend: active.capabilities.backend },
        }))
      }).pipe(
        Effect.ensuring(Effect.sync(() => {
          if (controller.#state === 'loading') {
            controller.#state = 'load-failed'
            controller.#stateCause = 'The replacement load did not complete'
          }
        })),
      )
      return controller.#loadSemaphore.withPermits(1)(replace)
    },
  )

  selectTrack(kind: TrackKind, trackId?: string): Promise<void> {
    return runVideoEffectPromise(this.selectTrackEffect(kind, trackId))
  }

  async #selectTrack(
    active: BackendVideoController,
    kind: TrackKind,
    trackId?: string,
  ): Promise<void> {
    if (kind !== 'subtitle') return active.selectTrack(kind, trackId)
    const external = this.#options.subtitles?.find((track) => track.id === trackId)
    if (trackId && !external) return active.selectTrack(kind, trackId)
    if (external) {
      await this.#selectExternalSubtitle(active, external)
      return
    }
    this.#subtitleTrack = undefined
    this.#subtitleCues = []
    this.#invalidateMetadata()
    this.#publishCues([])
    if (active.capabilities.subtitleTrackSelection) {
      await active.selectTrack(kind, trackId)
    }
  }

  readonly destroyEffect = Effect.fn('SwitchingVideoController.destroy')(() => {
    const controller = this
    return controller.#loadSemaphore.withPermits(1)(Effect.gen(function* () {
      if (controller.#state === 'destroyed') return
      const active = controller.#active
      controller.#active = undefined
      controller.#state = 'destroyed'
      controller.#stateCause = undefined
      controller.#unbindAbortSignal()
      controller.#stopForwarding()
      if (active) {
        yield* Effect.tryPromise({
          try: () => active.destroy(),
          catch: (cause) => controller.#transitionFailure(
            'destroyed',
            'destroy video',
            cause,
          ),
        })
      }
    }))
  })

  destroy(): Promise<void> {
    return runVideoEffectPromise(this.destroyEffect())
  }

  async #selectExternalSubtitle(
    active: BackendVideoController,
    track: ExternalSubtitleTrack,
  ): Promise<void> {
    const content = track.content ?? await this.#fetchSubtitle(track)
    if (this.#state === 'destroyed') return
    const result = parse(content)
    this.#subtitleTrack = track
    this.#subtitleCues = result.entries.map((entry, index) => ({
      id: entry.id || `${track.id}-${index}`,
      startSeconds: entry.from / 1000,
      endSeconds: entry.to / 1000,
      text: entry.text,
    }))
    this.#invalidateMetadata()
    // Disable an embedded subtitle renderer before emitting external cues.
    await active.selectTrack('subtitle', undefined).catch(() => undefined)
    this.dispatchEvent(new CustomEvent('trackchange', {
      detail: { kind: 'subtitle', trackId: track.id },
    }))
    this.#updateSubtitleCues(this.element.currentTime || 0)
  }

  async #fetchSubtitle(track: ExternalSubtitleTrack): Promise<string> {
    if (!track.src) throw new TypeError(`Subtitle track ${track.id} needs src or content`)
    const transport = this.#options.http ?? this.#defaultTransport
    const response = await transport.fetch(new Request(track.src, {
      headers: track.headers,
      signal: this.#options.signal,
    }))
    if (!response.ok) throw new Error(`Unable to load subtitle ${track.id}: HTTP ${response.status}`)
    return response.text()
  }

  #externalTracks(): readonly MediaTrack[] {
    return (this.#options.subtitles ?? []).map((track, index) => ({
      id: track.id,
      kind: 'subtitle',
      streamIndex: -(index + 1),
      codec: track.format ?? subtitleFormat(track),
      caps: 'text/plain',
      label: track.label,
      language: track.language,
      selected: track.id === this.#subtitleTrack?.id,
      default: track.default ?? false,
      forced: false,
    }))
  }

  #forwardEvents(active: BackendVideoController): void {
    const forward = <K extends keyof VideoControllerEventMap>(type: K) => {
      this.#unsubscribe.push(active.on(type, (event) => {
        if (type === 'timeupdate') {
          const detail = (event as VideoControllerEventMap['timeupdate']).detail
          this.#updateSubtitleCues(detail.currentTime)
        } else if (type === 'trackchange') {
          this.#invalidateMetadata()
        }
        this.dispatchEvent(new CustomEvent(type, { detail: event.detail }))
      }))
    }
    forward('timeupdate')
    forward('bufferprogress')
    forward('trackchange')
    forward('error')
  }

  #stopForwarding(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe()
  }

  #updateSubtitleCues(currentTime: number): void {
    if (!this.#subtitleTrack) return
    const visible: SubtitleCue[] = []
    for (const cue of this.#subtitleCues) {
      if (cue.startSeconds <= currentTime && cue.endSeconds > currentTime) visible.push(cue)
    }
    if (visible.length === this.#visibleCues.length
      && visible.every((cue, index) => cue.id === this.#visibleCues[index]?.id)) return
    this.#publishCues(visible)
  }

  #invalidateMetadata(): void {
    this.#metadataGeneration += 1
  }

  #readMetadata(active: BackendVideoController): ControllerMetadata {
    const sourceCapabilities = active.capabilities
    const sourceMedia = active.media
    const sourceTracks = active.tracks
    const cached = this.#metadata
    if (cached?.generation === this.#metadataGeneration
      && cached.sourceCapabilities === sourceCapabilities
      && cached.sourceTracks === sourceTracks
      && cached.tracks.length === sourceTracks.length + (this.#options.subtitles?.length ?? 0)
      && sourceTracks.every((track, index) => track === cached.tracks[index])
      && cached.media.durationSeconds === sourceMedia.durationSeconds
      && cached.media.seekable === sourceMedia.seekable
      && cached.media.seekableStartSeconds === sourceMedia.seekableStartSeconds
      && cached.media.seekableEndSeconds === sourceMedia.seekableEndSeconds
      && cached.media.live === sourceMedia.live
      && cached.media.container === sourceMedia.container
      && cached.media.chapters === sourceMedia.chapters) return cached
    const tracks = [...sourceTracks, ...this.#externalTracks()]
    const capabilities = this.#options.subtitles?.length
      && !sourceCapabilities.subtitleTrackSelection
      ? { ...sourceCapabilities, subtitleTrackSelection: true }
      : sourceCapabilities
    return this.#metadata = {
      generation: this.#metadataGeneration,
      sourceCapabilities,
      sourceTracks,
      capabilities,
      tracks,
      media: { ...sourceMedia, tracks },
    }
  }

  #publishCues(cues: readonly SubtitleCue[]): void {
    this.#visibleCues = cues
    this.dispatchEvent(new CustomEvent('subtitlecuechange', {
      detail: { trackId: this.#subtitleTrack?.id, cues },
    }))
  }

  #publishSubtitleError(trackId: string, cause: unknown): void {
    const message = errorMessage(cause)
    this.dispatchEvent(new CustomEvent('error', {
      detail: {
        code: 'subtitle_load_failed',
        message: `Unable to load subtitle ${trackId}: ${message}`,
      },
    }))
  }

  #readActive<A>(
    operation: string,
    read: (active: BackendVideoController) => A,
  ): Effect.Effect<A, VideoControllerStateError> {
    return Effect.suspend(() => {
      const active = this.#active
      return active
        ? Effect.succeed(read(active))
        : Effect.fail(this.#stateError(operation))
    })
  }

  #tryPromise<A>(
    operation: string,
    run: (active: BackendVideoController) => Promise<A>,
  ): Effect.Effect<A, VideoPlayerError> {
    return Effect.tryPromise({
      try: () => run(this.#requireActive(operation)),
      catch: (cause) => this.#normalizeOperationError(operation, cause),
    })
  }

  #trySync<A>(
    operation: string,
    run: (active: BackendVideoController) => A,
  ): Effect.Effect<A, VideoPlayerError> {
    return Effect.try({
      try: () => run(this.#requireActive(operation)),
      catch: (cause) => this.#normalizeOperationError(operation, cause),
    })
  }

  #promiseOperation<Args extends readonly unknown[], A>(
    span: string,
    operation: string,
    run: (active: BackendVideoController, ...args: Args) => Promise<A>,
  ): (...args: Args) => Effect.Effect<A, VideoPlayerError> {
    return Effect.fn(span)((...args: Args) => this.#tryPromise(
      operation,
      (active) => run(active, ...args),
    ))
  }

  #syncOperation<Args extends readonly unknown[], A>(
    span: string,
    operation: string,
    run: (active: BackendVideoController, ...args: Args) => A,
  ): (...args: Args) => Effect.Effect<A, VideoPlayerError> {
    return Effect.fn(span)((...args: Args) => this.#trySync(
      operation,
      (active) => run(active, ...args),
    ))
  }

  #requireActive(operation: string): BackendVideoController {
    if (this.#active) return this.#active
    if (this.#state === 'active') {
      this.#state = 'load-failed'
      this.#stateCause = 'The active backend is unavailable'
    }
    throw this.#stateError(operation)
  }

  #markLoadFailed(cause: unknown): void {
    this.#state = 'load-failed'
    this.#stateCause = errorMessage(cause)
  }

  #abortLoad(signal: AbortSignal, operation: string): VideoControllerStateError {
    this.#active = undefined
    this.#state = 'destroyed'
    this.#stateCause = errorMessage(signal.reason
      ?? new DOMException('The replacement load was aborted', 'AbortError'))
    this.#unbindAbortSignal()
    this.#stopForwarding()
    return this.#stateError(operation)
  }

  readonly #handleAbort = (): void => {
    void this.destroy().catch(() => undefined)
  }

  #bindAbortSignal(signal: AbortSignal | undefined): void {
    if (signal === this.#abortSignal) return
    this.#unbindAbortSignal()
    this.#abortSignal = signal
    if (!signal) return
    signal.addEventListener('abort', this.#handleAbort, { once: true })
    if (signal.aborted) this.#handleAbort()
  }

  #unbindAbortSignal(): void {
    this.#abortSignal?.removeEventListener('abort', this.#handleAbort)
    this.#abortSignal = undefined
  }

  #transitionFailure(
    state: Exclude<ControllerState, 'active' | 'loading'>,
    operation: string,
    cause: unknown,
  ): VideoControllerStateError {
    this.#state = state
    this.#stateCause = errorMessage(cause)
    return this.#stateError(operation)
  }

  #stateError(operation: string): VideoControllerStateError {
    const state = this.#state === 'active' ? 'load-failed' : this.#state
    const fields = {
      backend: this.#lastBackend,
      state,
      operation,
      message: `Cannot ${operation} while the video controller is ${state}`,
    }
    return this.#stateCause === undefined
      ? new VideoControllerStateError(fields)
      : new VideoControllerStateError({ ...fields, cause: this.#stateCause })
  }

  #normalizeOperationError(operation: string, cause: unknown): VideoPlayerError {
    if (isVideoPlayerError(cause)) return cause
    return new VideoLoadError({
      backend: this.#lastBackend,
      message: `Unable to ${operation}`,
      cause: errorMessage(cause),
    })
  }
}

export async function runVideoEffectPromise<A, E>(
  program: Effect.Effect<A, E>,
): Promise<A> {
  return unwrapExit(await Effect.runPromiseExit(program))
}

export function runVideoEffectSync<A, E>(program: Effect.Effect<A, E>): A {
  return unwrapExit(Effect.runSyncExit(program))
}

function unwrapExit<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isSuccess(exit)) return exit.value
  throw failureOrCause(exit.cause)
}

function failureOrCause<E>(cause: Cause.Cause<E>): E | unknown {
  return Option.match(Cause.failureOption(cause), {
    onNone: () => Cause.squash(cause),
    onSome: (error) => error,
  })
}

function subtitleFormat(track: ExternalSubtitleTrack): 'vtt' | 'srt' {
  return track.src?.toLowerCase().split(/[?#]/, 1)[0]?.endsWith('.srt') ? 'srt' : 'vtt'
}
