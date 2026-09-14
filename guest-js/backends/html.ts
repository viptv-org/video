import { VideoFeatureUnavailableError } from '../errors'
import { VideoEventTarget } from '../events'
import { bufferedAhead } from '../index'
import { startController } from './lifecycle'
import { emptyMediaInfo, inferContainer, normalizeSource } from './shared'
import type {
  AttachVideoOptions,
  MediaInfo,
  MediaTrack,
  PlaybackQuality,
  PlayerCapabilities,
  SessionStats,
  TrackKind,
  BackendVideoController,
  VideoControlsTarget,
  VideoFitMode,
} from '../index'

type HtmlBackend = 'html' | 'webos' | 'vizio'

let htmlSessionSequence = 0

export async function attachHtmlVideo(
  element: HTMLVideoElement,
  options: AttachVideoOptions,
  backend: HtmlBackend,
): Promise<BackendVideoController> {
  return startController(new HtmlVideoController(element, options, backend))
}

class HtmlVideoController extends VideoEventTarget implements BackendVideoController {
  readonly element: HTMLVideoElement
  readonly sessionId = `html-${Date.now()}-${++htmlSessionSequence}`
  readonly capabilities: PlayerCapabilities
  readonly #options: AttachVideoOptions
  readonly #backend: HtmlBackend
  readonly #media: MediaInfo = emptyMediaInfo()
  readonly #listeners: Array<readonly [string, EventListener]> = []
  readonly #original: {
    src: string
    preload: string | null
    playbackRate: number
    objectFit: string
    transform: string
  }
  #destroyed = false
  readonly #handleAbort = (): void => { void this.destroy().catch(() => undefined) }

  constructor(
    element: HTMLVideoElement,
    options: AttachVideoOptions,
    backend: HtmlBackend,
  ) {
    super()
    this.element = element
    this.#options = options
    this.#backend = backend
    this.capabilities = {
      backend,
      containers: 'platform',
      codecs: 'platform',
      drm: false,
      hdr: 'platform',
      playbackRate: backend !== 'webos',
      volume: true,
      videoFit: true,
      videoZoom: backend !== 'webos',
      audioTrackSelection: false,
      subtitleTrackSelection: true,
      customHeaders: false,
      frameAccurateSeeking: false,
    }
    this.#original = {
      src: element.getAttribute('src') ?? '',
      preload: element.getAttribute('preload'),
      playbackRate: element.playbackRate,
      objectFit: element.style.objectFit,
      transform: element.style.transform,
    }
  }

  get media(): MediaInfo { return this.#media }
  get tracks(): readonly MediaTrack[] { return this.#media.tracks }

  async start(): Promise<void> {
    if (this.#options.signal?.aborted) throw this.#options.signal.reason
    const source = normalizeSource(this.#options.source)
    if (source.headers || source.cookies || source.userAgent || source.referrer || source.tlsCaFile) {
      throw new VideoFeatureUnavailableError({
        backend: this.#backend,
        feature: 'customHeaders',
        message: `${this.#backend} playback cannot attach per-request headers to an HTML media element`,
      })
    }

    this.#listen('loadedmetadata', () => this.#refreshMedia())
    this.#listen('durationchange', () => this.#refreshMedia())
    this.#listen('progress', () => this.#emitBuffer())
    this.#listen('timeupdate', () => {
      this.dispatchEvent(new CustomEvent('timeupdate', { detail: { currentTime: this.element.currentTime } }))
    })
    this.#listen('error', () => {
      const message = this.element.error?.message || 'HTML media playback failed'
      this.dispatchEvent(new CustomEvent('error', { detail: { code: 'html-media', message } }))
    })

    if (this.element.preload === 'none') this.element.preload = 'auto'
    this.element.src = source.uri
    const startup = this.#waitForStartup()
    this.element.load()
    await startup
    if (!(this.element.videoWidth > 0)) {
      throw new VideoFeatureUnavailableError({
        backend: this.#backend,
        feature: 'videoFrameDecode',
        message: `${this.#backend} playback reached canplay without decoding a video frame`,
      })
    }
    this.#refreshMedia()
    if (source.startPositionSeconds !== undefined) {
      this.element.currentTime = Math.max(0, source.startPositionSeconds)
    }
    if (this.#options.autoplay) await this.play()
    this.#options.signal?.addEventListener('abort', this.#handleAbort, { once: true })
  }

  async play(): Promise<void> { await this.element.play() }
  pause(): void { this.element.pause() }

  async seek(positionSeconds: number): Promise<void> {
    this.element.currentTime = Math.max(0, positionSeconds)
  }

  async selectTrack(kind: TrackKind, trackId?: string): Promise<void> {
    if (kind !== 'subtitle') {
      throw new VideoFeatureUnavailableError({
        backend: this.#backend,
        feature: `${kind}TrackSelection`,
        message: `${this.#backend} does not expose ${kind} track selection through a portable browser API`,
      })
    }
    for (let index = 0; index < this.element.textTracks.length; index += 1) {
      const track = this.element.textTracks[index]
      track.mode = trackId === `subtitle-${index}` ? 'showing' : 'disabled'
    }
    this.#refreshMedia()
    this.dispatchEvent(new CustomEvent('trackchange', { detail: { kind, trackId } }))
  }

  async setVolume(volume: number): Promise<void> {
    this.element.volume = Math.min(1, Math.max(0, volume))
  }

  async setPlaybackRate(rate: number): Promise<void> {
    if (!this.capabilities.playbackRate) {
      throw new VideoFeatureUnavailableError({
        backend: this.#backend,
        feature: 'playbackRate',
        message: `${this.#backend} does not expose portable playback-rate changes`,
      })
    }
    this.element.playbackRate = rate
  }

  async setVideoFit(mode: VideoFitMode): Promise<void> {
    this.element.style.objectFit = mode === 'fit' ? 'contain' : mode === 'cover' ? 'cover' : 'fill'
  }

  async setVideoZoom(scale: number): Promise<void> {
    if (!this.capabilities.videoZoom) {
      throw new VideoFeatureUnavailableError({
        backend: this.#backend,
        feature: 'videoZoom',
        message: `${this.#backend} does not expose portable video-surface zoom`,
      })
    }
    this.element.style.transform = `scale(${Math.max(0.01, scale)})`
  }

  async stats(): Promise<SessionStats> {
    const quality = this.playbackQuality()
    return {
      sessionId: this.sessionId,
      playbackMode: 'html',
      encodedBytesBuffered: 0,
      bufferedAheadSeconds: this.bufferedAhead(),
      videoCodec: this.tracks.find((track) => track.kind === 'video')?.codec,
      audioCodec: this.tracks.find((track) => track.kind === 'audio')?.codec,
      hardwareBackend: this.#backend,
      decodedFrameCopies: 0,
      droppedFrames: quality.droppedVideoFrames,
      visible: !this.element.hidden,
      playing: !this.element.paused,
    }
  }

  bufferedAhead(): number { return bufferedAhead(this.element.buffered, this.element.currentTime) }

  playbackQuality(): PlaybackQuality {
    const quality = this.element.getVideoPlaybackQuality?.()
    const presentedFrames = quality?.totalVideoFrames ?? 0
    const droppedFrames = quality?.droppedVideoFrames ?? 0
    return {
      presentedFrames,
      mediaTimeSeconds: this.element.currentTime,
      measuredFps: 0,
      totalVideoFrames: presentedFrames,
      droppedVideoFrames: droppedFrames,
      droppedFramePercent: presentedFrames === 0 ? 0 : droppedFrames / presentedFrames * 100,
    }
  }

  refreshLayout(): void {}
  registerControls(_target: VideoControlsTarget): () => void { return () => undefined }

  async destroy(): Promise<void> {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#options.signal?.removeEventListener('abort', this.#handleAbort)
    this.element.pause()
    for (const [type, listener] of this.#listeners) this.element.removeEventListener(type, listener)
    this.#listeners.length = 0
    this.element.style.objectFit = this.#original.objectFit
    this.element.style.transform = this.#original.transform
    this.element.playbackRate = this.#original.playbackRate
    if (this.#original.src) this.element.setAttribute('src', this.#original.src)
    else this.element.removeAttribute('src')
    if (this.#original.preload === null) this.element.removeAttribute('preload')
    else this.element.setAttribute('preload', this.#original.preload)
    this.element.load()
  }

  #listen(type: string, listener: EventListener): void {
    this.element.addEventListener(type, listener)
    this.#listeners.push([type, listener])
  }

  #waitForStartup(): Promise<void> {
    if (this.element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const signal = this.#options.signal
      const cleanup = () => {
        this.element.removeEventListener('canplay', ready)
        this.element.removeEventListener('error', failed)
        signal?.removeEventListener('abort', aborted)
      }
      const ready = () => {
        cleanup()
        resolve()
      }
      const failed = () => {
        cleanup()
        reject(new Error(this.element.error?.message || 'HTML media playback failed during startup'))
      }
      const aborted = () => {
        cleanup()
        reject(signal?.reason ?? new DOMException('Video attachment was aborted', 'AbortError'))
      }
      this.element.addEventListener('canplay', ready, { once: true })
      this.element.addEventListener('error', failed, { once: true })
      signal?.addEventListener('abort', aborted, { once: true })
      if (this.element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) ready()
    })
  }

  #refreshMedia(): void {
    this.#media.durationSeconds = Number.isFinite(this.element.duration) ? this.element.duration : undefined
    this.#media.live = this.element.duration === Infinity
    this.#media.seekable = this.element.seekable.length > 0 || !this.#media.live
    this.#media.seekableStartSeconds = this.element.seekable.length > 0
      ? this.element.seekable.start(0)
      : undefined
    this.#media.seekableEndSeconds = this.element.seekable.length > 0
      ? this.element.seekable.end(this.element.seekable.length - 1)
      : this.#media.durationSeconds
    this.#media.container = inferContainer(this.element.currentSrc || this.element.src)
    const tracks: MediaTrack[] = []
    if (this.element.videoWidth > 0) {
      tracks.push({
        id: 'video-0', kind: 'video', streamIndex: 0, codec: '', caps: '', selected: true,
        default: true, forced: false, width: this.element.videoWidth, height: this.element.videoHeight,
      })
    }
    for (let index = 0; index < this.element.textTracks.length; index += 1) {
      const track = this.element.textTracks[index]
      tracks.push({
        id: `subtitle-${index}`, kind: 'subtitle', streamIndex: index, codec: 'webvtt', caps: '',
        label: track.label, language: track.language, selected: track.mode === 'showing',
        default: track.mode === 'showing', forced: false,
      })
    }
    this.#media.tracks = tracks
  }

  #emitBuffer(): void {
    this.dispatchEvent(new CustomEvent('bufferprogress', {
      detail: { bufferedAhead: this.bufferedAhead() },
    }))
  }
}
