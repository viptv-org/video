import { VideoBackendUnavailableError, VideoFeatureUnavailableError } from '../errors'
import { VideoEventTarget } from '../events'
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

interface AvPlayTrackInfo {
  type: 'VIDEO' | 'AUDIO' | 'TEXT'
  index: number
  extra_info?: string
}

interface AvPlayListener {
  onbufferingstart?: () => void
  onbufferingprogress?: (percent: number) => void
  onbufferingcomplete?: () => void
  oncurrentplaytime?: (milliseconds: number) => void
  onstreamcompleted?: () => void
  onerror?: (error: string) => void
  onevent?: (event: string, data: string) => void
  onsubtitlechange?: (duration: number, text: string, data: unknown, type: number) => void
  ondrmevent?: (event: string, data: unknown) => void
}

interface AvPlayApi {
  open(uri: string): void
  close(): void
  prepareAsync(success: () => void, failure: (error: unknown) => void): void
  play(): void
  pause(): void
  stop(): void
  seekTo(milliseconds: number, success?: () => void, failure?: (error: unknown) => void): void
  getState(): string
  getDuration(): number
  getCurrentTime(): number
  getTotalTrackInfo(): AvPlayTrackInfo[]
  getCurrentStreamInfo(): AvPlayTrackInfo[]
  getStreamingProperty(type: 'IS_LIVE' | 'GET_LIVE_DURATION'): string
  setStreamingProperty(type: 'COOKIE' | 'USER_AGENT', value: string): void
  setSilentSubtitle(onoff: boolean): void
  setSelectTrack(type: 'AUDIO' | 'TEXT', index: number): void
  setDisplayRect(x: number, y: number, width: number, height: number): void
  setDisplayMethod(method: string): void
  setListener(listener: AvPlayListener): void
}

declare global {
  interface Window {
    webapis?: { avplay?: AvPlayApi }
  }
}

let tizenSessionSequence = 0
let tizenAvPlayOwner: symbol | undefined

const AVPLAY_DISPLAY_WIDTH = 1920
const AVPLAY_DISPLAY_HEIGHT = 1080

export function hasTizenAvPlay(): boolean {
  return typeof window !== 'undefined' && Boolean(window.webapis?.avplay)
}

export async function attachTizenVideo(
  element: HTMLVideoElement,
  options: AttachVideoOptions,
): Promise<BackendVideoController> {
  const avplay = window.webapis?.avplay
  if (!avplay) {
    throw new VideoBackendUnavailableError({
      backend: 'tizen',
      message: 'Samsung AVPlay is not available; load $WEBAPIS/webapis/webapis.js on a Tizen TV',
    })
  }
  return startController(new TizenVideoController(element, options, avplay))
}

class TizenVideoController extends VideoEventTarget implements BackendVideoController {
  readonly element: HTMLVideoElement
  readonly sessionId = `tizen-${Date.now()}-${++tizenSessionSequence}`
  readonly capabilities: PlayerCapabilities = {
    backend: 'tizen',
    containers: 'platform',
    codecs: 'platform',
    drm: false,
    hdr: 'platform',
    playbackRate: false,
    volume: false,
    videoFit: true,
    videoZoom: false,
    audioTrackSelection: true,
    subtitleTrackSelection: true,
    customHeaders: false,
    frameAccurateSeeking: false,
  }
  readonly #options: AttachVideoOptions
  readonly #avplay: AvPlayApi
  readonly #media: MediaInfo = emptyMediaInfo()
  readonly #originalVisibility: string
  readonly #ownerToken = Symbol('air-tizen-avplay-owner')
  #resize?: ResizeObserver
  #playerObject?: HTMLObjectElement
  #ownsAvPlay = false
  #opened = false
  #hasTotalTrackInfo = false
  #destroyed = false
  #currentTime = 0
  #playing = false
  readonly #handleAbort = (): void => { void this.destroy().catch(() => undefined) }

  constructor(element: HTMLVideoElement, options: AttachVideoOptions, avplay: AvPlayApi) {
    super()
    this.element = element
    this.#options = options
    this.#avplay = avplay
    this.#originalVisibility = element.style.visibility
  }

  get media(): MediaInfo { return this.#media }
  get tracks(): readonly MediaTrack[] { return this.#media.tracks }

  async start(): Promise<void> {
    if (this.#options.signal?.aborted) throw this.#options.signal.reason
    const source = normalizeSource(this.#options.source)
    if (source.headers || source.referrer || source.tlsCaFile) {
      throw new VideoFeatureUnavailableError({
        backend: 'tizen',
        feature: 'customHeaders',
        message: 'Samsung AVPlay does not provide portable arbitrary headers, referrer, or TLS CA overrides',
      })
    }
    this.#acquireAvPlay()
    this.#installPlayerObject()
    this.element.style.visibility = 'hidden'
    this.#avplay.open(source.uri)
    this.#opened = true
    if (source.cookies !== undefined) this.#avplay.setStreamingProperty('COOKIE', source.cookies)
    if (source.userAgent !== undefined) this.#avplay.setStreamingProperty('USER_AGENT', source.userAgent)
    this.#avplay.setListener({
      onbufferingprogress: () => {
        this.dispatchEvent(new CustomEvent('bufferprogress', {
          detail: { bufferedAhead: this.bufferedAhead() },
        }))
      },
      oncurrentplaytime: (milliseconds) => {
        this.#currentTime = milliseconds / 1000
        this.#refreshLiveWindow()
        if (!this.#hasTotalTrackInfo) this.#tryRefreshTotalTrackInfo()
        this.dispatchEvent(new CustomEvent('timeupdate', { detail: { currentTime: this.#currentTime } }))
      },
      onstreamcompleted: () => {
        this.#playing = false
        this.element.dispatchEvent(new Event('pause'))
        if (!this.#media.live) this.element.dispatchEvent(new Event('ended'))
      },
      onerror: (error) => {
        this.dispatchEvent(new CustomEvent('error', {
          detail: { code: 'tizen-avplay', message: String(error) },
        }))
      },
    })
    this.refreshLayout()
    await new Promise<void>((resolve, reject) => this.#avplay.prepareAsync(resolve, reject))
    const durationMilliseconds = this.#avplay.getDuration()
    this.#media.live = this.#isLive(durationMilliseconds)
    this.#media.durationSeconds = this.#media.live
      ? undefined
      : this.#millisecondsToOptionalSeconds(durationMilliseconds)
    if (this.#media.live) this.#refreshLiveWindow()
    else {
      this.#media.seekable = true
      this.#media.seekableStartSeconds = 0
      this.#media.seekableEndSeconds = this.#media.durationSeconds
    }
    this.#media.container = inferContainer(source.uri)
    this.#refreshCurrentTrackInfo()
    if (source.startPositionSeconds !== undefined) await this.seek(source.startPositionSeconds)
    if (typeof ResizeObserver !== 'undefined') {
      this.#resize = new ResizeObserver(() => this.refreshLayout())
      this.#resize.observe(this.element)
    }
    window.addEventListener('resize', this.#handleResize)
    window.addEventListener('scroll', this.#handleResize, true)
    this.#options.signal?.addEventListener('abort', this.#handleAbort, { once: true })
    this.element.dispatchEvent(new Event('loadedmetadata'))
    this.element.dispatchEvent(new Event('durationchange'))
    this.element.dispatchEvent(new Event('canplay'))
    if (this.#options.autoplay) await this.play()
  }

  async play(): Promise<void> {
    this.#avplay.play()
    this.#playing = true
    this.#tryRefreshTotalTrackInfo()
    this.element.dispatchEvent(new Event('play'))
    this.element.dispatchEvent(new Event('playing'))
  }

  pause(): void {
    if (this.#avplay.getState() === 'PLAYING') this.#avplay.pause()
    this.#playing = false
    this.element.dispatchEvent(new Event('pause'))
  }

  async seek(positionSeconds: number): Promise<void> {
    if (!this.#media.seekable) {
      throw new VideoFeatureUnavailableError({
        backend: 'tizen',
        feature: 'seeking',
        message: 'The active AVPlay stream does not expose a seekable window',
      })
    }
    const minimum = this.#media.seekableStartSeconds ?? 0
    const maximum = this.#media.seekableEndSeconds
      ?? this.#media.durationSeconds
      ?? Number.POSITIVE_INFINITY
    const target = clamp(positionSeconds, minimum, maximum)
    await new Promise<void>((resolve, reject) => {
      this.#avplay.seekTo(Math.max(0, Math.round(target * 1000)), resolve, reject)
    })
    this.#currentTime = Math.max(0, target)
  }

  async selectTrack(kind: TrackKind, trackId?: string): Promise<void> {
    if (kind === 'video') {
      throw new VideoFeatureUnavailableError({
        backend: 'tizen',
        feature: 'videoTrackSelection',
        message: 'Samsung AVPlay setSelectTrack supports audio and subtitle tracks only',
      })
    }
    this.#assertTrackSelectionState(kind)
    if (!trackId) {
      if (kind === 'subtitle') {
        this.#avplay.setSilentSubtitle(true)
        this.#media.tracks = this.#media.tracks.map((candidate) => ({
          ...candidate,
          selected: candidate.kind === 'subtitle' ? false : candidate.selected,
        }))
        this.dispatchEvent(new CustomEvent('trackchange', { detail: { kind } }))
        return
      }
      throw new VideoFeatureUnavailableError({
        backend: 'tizen',
        feature: `${kind}TrackDisable`,
        message: `AVPlay cannot disable the selected ${kind} track through the common API`,
      })
    }
    const track = this.#media.tracks.find((candidate) => candidate.id === trackId && candidate.kind === kind)
    if (!track) throw new Error(`Unknown ${kind} track: ${trackId}`)
    if (kind === 'subtitle') this.#avplay.setSilentSubtitle(false)
    this.#avplay.setSelectTrack(kind === 'audio' ? 'AUDIO' : 'TEXT', track.streamIndex)
    this.#media.tracks = this.#media.tracks.map((candidate) => ({
      ...candidate,
      selected: candidate.kind === kind ? candidate.id === trackId : candidate.selected,
    }))
    this.dispatchEvent(new CustomEvent('trackchange', { detail: { kind, trackId } }))
  }

  async setVolume(_volume: number): Promise<void> {}

  async setPlaybackRate(_rate: number): Promise<void> {
    throw new VideoFeatureUnavailableError({
      backend: 'tizen',
      feature: 'playbackRate',
      message: 'The common Tizen backend does not expose AVPlay trick-play speeds',
    })
  }

  async setVideoFit(mode: VideoFitMode): Promise<void> {
    const method = mode === 'fit'
      ? 'PLAYER_DISPLAY_MODE_LETTER_BOX'
      : mode === 'cover'
        ? 'PLAYER_DISPLAY_MODE_FULL_SCREEN'
        : 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO'
    this.#avplay.setDisplayMethod(method)
  }

  async setVideoZoom(_scale: number): Promise<void> {
    throw new VideoFeatureUnavailableError({
      backend: 'tizen',
      feature: 'videoZoom',
      message: 'AVPlay does not expose arbitrary video-surface scaling',
    })
  }

  async stats(): Promise<SessionStats> {
    return {
      sessionId: this.sessionId,
      playbackMode: 'platform',
      encodedBytesBuffered: 0,
      bufferedAheadSeconds: this.bufferedAhead(),
      videoCodec: this.tracks.find((track) => track.kind === 'video' && track.selected)?.codec,
      audioCodec: this.tracks.find((track) => track.kind === 'audio' && track.selected)?.codec,
      hardwareBackend: 'Samsung AVPlay',
      decodedFrameCopies: 0,
      droppedFrames: 0,
      visible: !this.element.hidden,
      playing: this.#playing,
    }
  }

  bufferedAhead(): number { return 0 }

  playbackQuality(): PlaybackQuality {
    return {
      presentedFrames: 0,
      mediaTimeSeconds: this.#currentTime,
      measuredFps: 0,
      totalVideoFrames: 0,
      droppedVideoFrames: 0,
      droppedFramePercent: 0,
    }
  }

  refreshLayout(): void {
    const rect = this.element.getBoundingClientRect()
    if (this.#playerObject) {
      Object.assign(this.#playerObject.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${Math.max(0, rect.width)}px`,
        height: `${Math.max(0, rect.height)}px`,
      })
    }
    const viewportWidth = Math.max(
      1,
      document.documentElement.clientWidth || window.innerWidth || AVPLAY_DISPLAY_WIDTH,
    )
    const viewportHeight = Math.max(
      1,
      document.documentElement.clientHeight || window.innerHeight || AVPLAY_DISPLAY_HEIGHT,
    )
    const left = clamp(rect.left, 0, viewportWidth)
    const top = clamp(rect.top, 0, viewportHeight)
    const right = clamp(rect.right, left, viewportWidth)
    const bottom = clamp(rect.bottom, top, viewportHeight)
    const x = clamp(Math.round(left * AVPLAY_DISPLAY_WIDTH / viewportWidth), 0, AVPLAY_DISPLAY_WIDTH - 1)
    const y = clamp(Math.round(top * AVPLAY_DISPLAY_HEIGHT / viewportHeight), 0, AVPLAY_DISPLAY_HEIGHT - 1)
    const width = clamp(
      Math.round((right - left) * AVPLAY_DISPLAY_WIDTH / viewportWidth),
      1,
      AVPLAY_DISPLAY_WIDTH - x,
    )
    const height = clamp(
      Math.round((bottom - top) * AVPLAY_DISPLAY_HEIGHT / viewportHeight),
      1,
      AVPLAY_DISPLAY_HEIGHT - y,
    )
    this.#avplay.setDisplayRect(
      x,
      y,
      width,
      height,
    )
  }

  registerControls(_target: VideoControlsTarget): () => void { return () => undefined }

  async destroy(): Promise<void> {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#options.signal?.removeEventListener('abort', this.#handleAbort)
    this.#resize?.disconnect()
    window.removeEventListener('resize', this.#handleResize)
    window.removeEventListener('scroll', this.#handleResize, true)
    try {
      if (this.#ownsAvPlay && this.#opened) {
        const state = this.#avplay.getState()
        if (state === 'PLAYING' || state === 'PAUSED' || state === 'READY') this.#avplay.stop()
      }
    } finally {
      try {
        if (this.#ownsAvPlay && this.#opened) this.#avplay.close()
      } finally {
        this.#opened = false
        this.#playerObject?.remove()
        this.#playerObject = undefined
        this.element.style.visibility = this.#originalVisibility
        this.#releaseAvPlay()
      }
    }
  }

  readonly #handleResize = (): void => this.refreshLayout()

  #acquireAvPlay(): void {
    if (tizenAvPlayOwner !== undefined) {
      throw new VideoBackendUnavailableError({
        backend: 'tizen',
        message: 'Samsung AVPlay already has an active Air video controller',
      })
    }
    tizenAvPlayOwner = this.#ownerToken
    this.#ownsAvPlay = true
  }

  #releaseAvPlay(): void {
    if (!this.#ownsAvPlay) return
    if (tizenAvPlayOwner === this.#ownerToken) tizenAvPlayOwner = undefined
    this.#ownsAvPlay = false
  }

  #installPlayerObject(): void {
    const parent = this.element.parentElement
    if (!parent) throw new Error('Samsung AVPlay requires the video anchor to have a parent element')
    const playerObject = document.createElement('object')
    playerObject.type = 'application/avplayer'
    playerObject.setAttribute('aria-hidden', 'true')
    playerObject.setAttribute('data-air-video-plane', 'tizen-avplay')
    Object.assign(playerObject.style, {
      position: 'fixed',
      pointerEvents: 'none',
    })
    parent.insertBefore(playerObject, this.element.nextSibling)
    this.#playerObject = playerObject
  }

  #refreshCurrentTrackInfo(): void {
    const current = this.#avplay.getCurrentStreamInfo()
    this.#media.tracks = current.map((track) => describeTrack(track, true))
  }

  #tryRefreshTotalTrackInfo(): void {
    if (this.#hasTotalTrackInfo || this.#avplay.getState() !== 'PLAYING') return
    try {
      const selected = new Set(this.#avplay.getCurrentStreamInfo().map(trackKey))
      this.#media.tracks = this.#avplay.getTotalTrackInfo().map((track) => {
        return describeTrack(track, selected.has(trackKey(track)))
      })
      this.#hasTotalTrackInfo = true
      for (const kind of ['audio', 'subtitle'] as const) {
        const selectedTrack = this.#media.tracks.find((track) => track.kind === kind && track.selected)
        if (this.#media.tracks.some((track) => track.kind === kind)) {
          this.dispatchEvent(new CustomEvent('trackchange', {
            detail: { kind, trackId: selectedTrack?.id },
          }))
        }
      }
    } catch {
      // Some firmware reports PLAYING before track enumeration is ready. The
      // first current-play-time callback retries without failing playback.
    }
  }

  #assertTrackSelectionState(kind: 'audio' | 'subtitle'): void {
    const state = this.#avplay.getState()
    const supported = state === 'PLAYING' || (kind === 'subtitle' && state === 'PAUSED')
    if (supported) return
    throw new VideoFeatureUnavailableError({
      backend: 'tizen',
      feature: `${kind}TrackSelectionState`,
      message: `Samsung AVPlay ${kind} track selection requires active playback${
        kind === 'subtitle' ? ' or a paused player' : ''}`,
    })
  }

  #millisecondsToOptionalSeconds(milliseconds: number): number | undefined {
    return milliseconds > 0 ? milliseconds / 1000 : undefined
  }

  #isLive(durationMilliseconds: number): boolean {
    try {
      const value = this.#avplay.getStreamingProperty('IS_LIVE')
      if (/^(1|true|yes)$/i.test(value.trim())) return true
      if (/^(0|false|no)$/i.test(value.trim())) return false
    } catch {
      // Older firmware and non-adaptive sources can reject this property.
    }
    return durationMilliseconds <= 0
  }

  #refreshLiveWindow(): void {
    if (!this.#media.live) return
    try {
      const [startText, endText] = this.#avplay.getStreamingProperty('GET_LIVE_DURATION').split('|')
      const start = Number(startText)
      const end = Number(endText)
      const valid = Number.isFinite(start) && Number.isFinite(end) && end > start
      this.#media.seekable = valid
      this.#media.seekableStartSeconds = valid ? start / 1000 : undefined
      this.#media.seekableEndSeconds = valid ? end / 1000 : undefined
    } catch {
      this.#media.seekable = false
      this.#media.seekableStartSeconds = undefined
      this.#media.seekableEndSeconds = undefined
    }
  }
}

function describeTrack(track: AvPlayTrackInfo, selected: boolean): MediaTrack {
  const kind: TrackKind = track.type === 'VIDEO' ? 'video' : track.type === 'AUDIO' ? 'audio' : 'subtitle'
  let extra: Record<string, unknown> = {}
  try { extra = track.extra_info ? JSON.parse(track.extra_info) as Record<string, unknown> : {} }
  catch { /* AVPlay may provide vendor-specific non-JSON data */ }
  const language = typeof extra.track_lang === 'string'
    ? extra.track_lang
    : typeof extra.language === 'string' ? extra.language : undefined
  return {
    id: `${kind}-${track.index}`,
    kind,
    streamIndex: track.index,
    codec: String(extra.fourCC ?? extra.codec ?? ''),
    caps: '',
    label: language,
    language,
    selected,
    default: selected,
    forced: false,
    width: typeof extra.Width === 'number' ? extra.Width : undefined,
    height: typeof extra.Height === 'number' ? extra.Height : undefined,
  }
}

function trackKey(track: AvPlayTrackInfo): string { return `${track.type}:${track.index}` }

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
