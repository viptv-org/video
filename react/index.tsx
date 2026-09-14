import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  attachVideo,
  type AttachVideoOptions,
  type MediaInfo,
  type PlayerCapabilities,
  type TrackKind,
  type VideoController,
  type VideoClient,
  type VideoFitMode,
  type VideoSource,
} from '../guest-js/index'
import {
  ControlContainer,
  FocusableButton,
  FocusableSlider,
  FullscreenIcon,
  PauseIcon,
  PlayIcon,
  TrackButton,
  VIDEO_CONTROLS_PROPS,
  VolumeIcon,
  formatBuffer,
  formatTime,
} from './controls'
import playerStyles from './player.css?raw'

export { VideoControlRegion, useVideoControlRegion } from './controls'
export type { VideoControlRegionProps } from './controls'

const PLAYER_STYLE_ATTRIBUTE = 'data-air-video-player-styles'

function installPlayerStyles(): void {
  if (typeof document === 'undefined'
    || document.head.querySelector(`[${PLAYER_STYLE_ATTRIBUTE}]`)) return
  const style = document.createElement('style')
  style.setAttribute(PLAYER_STYLE_ATTRIBUTE, '')
  style.textContent = playerStyles
  document.head.append(style)
}

export interface VideoPlayerProps {
  client?: VideoClient
  source: string | VideoSource
  options?: Omit<AttachVideoOptions, 'source' | 'autoplay' | 'deviceProfile'>
  autoPlay?: boolean
  muted?: boolean
  controls?: boolean
  tvMode?: boolean
  title?: string
  className?: string
  style?: CSSProperties
  poster?: string
  children?: ReactNode
  reloadKey?: string | number
  onController?: (controller: VideoController | null) => void
  onReady?: (controller: VideoController) => void
  onError?: (error: Error) => void
}

export function VideoPlayer({
  client,
  source,
  options,
  autoPlay = false,
  muted = false,
  controls = true,
  tvMode = false,
  title = 'Video player',
  className = '',
  style,
  poster,
  children,
  reloadKey,
  onController,
  onReady,
  onError,
}: VideoPlayerProps) {
  useInsertionEffect(installPlayerStyles, [])
  const rootRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const controllerRef = useRef<VideoController | null>(null)
  const optionsRef = useRef(options)
  const callbacksRef = useRef({ onController, onReady, onError })
  const hideTimerRef = useRef<number | undefined>(undefined)
  const [media, setMedia] = useState<MediaInfo>(EMPTY_MEDIA)
  const [capabilities, setCapabilities] = useState<PlayerCapabilities>()
  const [currentTime, setCurrentTime] = useState(0)
  const [bufferedTime, setBufferedTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [volume, setVolumeState] = useState(muted ? 0 : 1)
  const [fit, setFit] = useState<VideoFitMode>('fit')
  const [zoom, setZoom] = useState(1)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [scrubTime, setScrubTime] = useState<number>()
  const sourceKey = typeof source === 'string' ? source : source.uri

  optionsRef.current = options
  callbacksRef.current = { onController, onReady, onError }

  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    const videoElement = element
    let cancelled = false
    let lastMedia: MediaInfo | undefined
    const abort = new AbortController()

    const update = (forceMedia = false) => {
      const controller = controllerRef.current
      if (!controller) return
      const latest = controller.media
      if (forceMedia || mediaChanged(latest, lastMedia)) {
        lastMedia = latest
        setMedia({ ...latest })
      }
      const quality = controller.playbackQuality()
      const position = quality.mediaTimeSeconds ?? element.currentTime
      if (Number.isFinite(position)) setCurrentTime(Math.max(0, position))
      setBufferedTime(Math.max(0, position + controller.bufferedAhead()))
    }
    const handleTime = (event: Event) => {
      const detail = (event as CustomEvent<{ currentTime?: number }>).detail
      if (Number.isFinite(detail?.currentTime)) setCurrentTime(Math.max(0, detail.currentTime ?? 0))
      update()
    }
    const handleError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail
      reportError(new Error(detail?.message ?? 'Playback failed'))
    }
    const handlePlay = () => setPlaying(true)
    const handlePause = () => setPlaying(false)
    const handleBufferProgress = () => update()
    const handleTrackChange = () => update(true)

    async function open() {
      setLoading(true)
      setError('')
      setCurrentTime(0)
      setBufferedTime(0)
      setMedia(EMPTY_MEDIA)
      setCapabilities(undefined)
      setZoom(1)
      try {
        const attach = client ? client.attach.bind(client) : attachVideo
        const controller = await attach(videoElement, {
          ...optionsRef.current,
          source,
          autoplay: false,
          deviceProfile: tvMode ? 'tv' : 'auto',
          signal: abort.signal,
        })
        if (cancelled) {
          await controller.destroy()
          return
        }
        controllerRef.current = controller
        setCapabilities(controller.capabilities)
        callbacksRef.current.onController?.(controller)
        controller.addEventListener('timeupdate', handleTime)
        controller.addEventListener('bufferprogress', handleBufferProgress)
        controller.addEventListener('trackchange', handleTrackChange)
        controller.addEventListener('error', handleError)
        videoElement.addEventListener('play', handlePlay)
        videoElement.addEventListener('pause', handlePause)
        videoElement.volume = volume
        if (controller.capabilities.volume) await controller.setVolume(volume)
        update()
        setLoading(false)
        callbacksRef.current.onReady?.(controller)
        if (autoPlay) {
          await controller.play()
          setPlaying(true)
        }
      } catch (reason) {
        if (!cancelled && !abort.signal.aborted) reportError(toError(reason))
      }
    }

    function reportError(reason: Error) {
      setLoading(false)
      setError(reason.message)
      callbacksRef.current.onError?.(reason)
    }

    void open()
    return () => {
      cancelled = true
      abort.abort()
      const controller = controllerRef.current
      controllerRef.current = null
      callbacksRef.current.onController?.(null)
      if (controller) {
        controller.removeEventListener('timeupdate', handleTime)
        controller.removeEventListener('bufferprogress', handleBufferProgress)
        controller.removeEventListener('trackchange', handleTrackChange)
        controller.removeEventListener('error', handleError)
        videoElement.removeEventListener('play', handlePlay)
        videoElement.removeEventListener('pause', handlePause)
        void controller.destroy()
      }
    }
  // reloadKey is the explicit escape hatch for option/header changes on the same URI.
  }, [client, sourceKey, reloadKey, tvMode])

  useEffect(() => () => {
    if (hideTimerRef.current !== undefined) window.clearTimeout(hideTimerRef.current)
  }, [])

  const revealControls = useCallback(() => {
    setControlsVisible(true)
    if (hideTimerRef.current !== undefined) window.clearTimeout(hideTimerRef.current)
    if (playing) {
      hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), tvMode ? 5_000 : 2_500)
    }
  }, [playing, tvMode])

  const togglePlayback = useCallback(async () => {
    const controller = controllerRef.current
    if (!controller) return
    if (playing) {
      controller.pause()
      setPlaying(false)
      setControlsVisible(true)
    } else {
      await controller.play()
      setPlaying(true)
      revealControls()
    }
  }, [playing, revealControls])

  const seekTo = useCallback(async (seconds: number) => {
    const controller = controllerRef.current
    if (!controller || !media.seekable) return
    const minimum = media.seekableStartSeconds ?? 0
    const maximum = media.seekableEndSeconds
      ?? media.durationSeconds
      ?? Number.POSITIVE_INFINITY
    const target = Math.min(maximum, Math.max(minimum, seconds))
    setCurrentTime(target)
    setScrubTime(undefined)
    await controller.seek(target)
  }, [media.durationSeconds, media.seekable, media.seekableEndSeconds, media.seekableStartSeconds])

  const seekRelative = useCallback((delta: number) => {
    void seekTo(currentTime + delta)
  }, [currentTime, seekTo])

  const changeVolume = useCallback((next: number) => {
    const clamped = Math.min(1, Math.max(0, next))
    setVolumeState(clamped)
    if (videoRef.current) videoRef.current.volume = clamped
    if (controllerRef.current?.capabilities.volume) void controllerRef.current.setVolume(clamped)
  }, [])

  const cycleTrack = useCallback((kind: TrackKind) => {
    const tracks = media.tracks.filter((track) => track.kind === kind)
    if (tracks.length === 0) return
    const selected = tracks.findIndex((track) => track.selected)
    const next = kind === 'subtitle'
      ? selected < 0 ? 0 : selected + 1 >= tracks.length ? -1 : selected + 1
      : (selected + 1) % tracks.length
    void controllerRef.current?.selectTrack(kind, next < 0 ? undefined : tracks[next].id)
  }, [media.tracks])

  const cycleFit = useCallback(() => {
    const next: VideoFitMode = fit === 'fit' ? 'cover' : 'fit'
    setFit(next)
    void controllerRef.current?.setVideoFit(next)
  }, [fit])

  const cycleZoom = useCallback(() => {
    const steps = [1, 1.1, 1.2, 1.3]
    const current = steps.findIndex((value) => Math.abs(value - zoom) < 0.01)
    const next = steps[(current + 1) % steps.length]
    setZoom(next)
    void controllerRef.current?.setVideoZoom(next)
  }, [zoom])

  const toggleFullscreen = useCallback(async () => {
    const root = rootRef.current
    if (!root) return
    if (document.fullscreenElement) await document.exitFullscreen()
    else await root.requestFullscreen()
  }, [])

  const duration = media.durationSeconds ?? 0
  const seekStart = media.seekableStartSeconds ?? 0
  const seekEnd = media.seekableEndSeconds ?? duration
  const seekSpan = Math.max(0, seekEnd - seekStart)
  const canSeek = media.seekable && (media.live ? seekSpan > 0 : duration > 0)
  const shownTime = scrubTime ?? currentTime
  const timelineValue = canSeek ? Math.min(seekEnd, Math.max(seekStart, shownTime)) : seekStart
  const playedPercent = canSeek ? Math.min(100, Math.max(0, (timelineValue - seekStart) / seekSpan * 100)) : 0
  const bufferedPercent = canSeek
    ? Math.min(100, Math.max(0, (bufferedTime - seekStart) / seekSpan * 100))
    : 0
  const audioTracks = useMemo(() => media.tracks.filter((track) => track.kind === 'audio'), [media])
  const subtitleTracks = useMemo(
    () => media.tracks.filter((track) => track.kind === 'subtitle'),
    [media],
  )

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    revealControls()
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
    if (event.key === ' ' || event.key.toLowerCase() === 'k' || event.key === 'MediaPlayPause') {
      event.preventDefault()
      void togglePlayback()
    } else if (!tvMode && canSeek && event.key === 'ArrowLeft') {
      event.preventDefault()
      seekRelative(-10)
    } else if (!tvMode && canSeek && event.key === 'ArrowRight') {
      event.preventDefault()
      seekRelative(10)
    } else if (event.key.toLowerCase() === 'f') {
      void toggleFullscreen()
    }
  }

  return (
    <div
      ref={rootRef}
      className={`tvp-player ${tvMode ? 'tvp-tv' : ''} ${className}`.trim()}
      style={style}
      data-controls-visible={!playing || controlsVisible}
      data-loading={loading}
      data-playing={playing}
      data-live={media.live}
      onKeyDown={handleKeyDown}
      onMouseMove={revealControls}
      onPointerDown={revealControls}
      role="region"
      aria-label={title}
    >
      <video ref={videoRef} className="tvp-video" poster={poster} playsInline muted={muted} />
      <div className="tvp-overlay-slot" {...VIDEO_CONTROLS_PROPS}>{children}</div>
      {loading && <div className="tvp-status" role="status" {...VIDEO_CONTROLS_PROPS}><span />Loading video</div>}
      {error && <div className="tvp-error" role="alert" {...VIDEO_CONTROLS_PROPS}>{error}</div>}
      {controls && (
        <ControlContainer tvMode={tvMode} focusResetKey={reloadKey}>
            <FocusableSlider
              tvMode={tvMode}
              focusKey="AIR_VIDEO_TIMELINE"
              className="tvp-timeline"
              min={seekStart}
              max={Math.max(seekEnd, seekStart + 0.01)}
              step={0.1}
              value={timelineValue}
              disabled={!canSeek}
              aria-label={media.live ? 'Live seek' : 'Seek'}
              aria-valuetext={media.live ? liveTimeLabel(timelineValue, seekEnd) : formatTime(timelineValue)}
              style={{
                '--tvp-played': `${playedPercent}%`,
                '--tvp-buffered': `${bufferedPercent}%`,
              } as CSSProperties}
              onChange={(event) => setScrubTime(Number(event.currentTarget.value))}
              onPointerUp={() => scrubTime !== undefined && void seekTo(scrubTime)}
              onKeyUp={(event) => {
                if (event.key === 'Home') void seekTo(seekStart)
                if (event.key === 'End') void seekTo(seekEnd)
              }}
              onTvLeft={() => seekRelative(-10)}
              onTvRight={() => seekRelative(10)}
            />
            <div className="tvp-control-row">
              <FocusableButton
                tvMode={tvMode}
                focusKey="AIR_VIDEO_PLAY"
                className="tvp-icon"
                aria-label={playing ? 'Pause' : 'Play'}
                onPress={() => void togglePlayback()}
              >
                {playing ? <PauseIcon /> : <PlayIcon />}
              </FocusableButton>
              <output className="tvp-time" aria-live="off">
                {media.live
                  ? formatLiveTime(timelineValue, seekEnd)
                  : <>{formatTime(shownTime)} <span>/</span> {formatTime(duration)}</>}
              </output>
              {media.live && canSeek && (
                <FocusableButton
                  tvMode={tvMode}
                  focusKey="AIR_VIDEO_LIVE"
                  className="tvp-text-button tvp-live-button"
                  aria-label="Go to live"
                  onPress={() => void seekTo(seekEnd)}
                >
                  Live
                </FocusableButton>
              )}
              <span className="tvp-buffer-label">{formatBuffer(controllerRef.current?.bufferedAhead() ?? 0)}</span>
              <div className="tvp-spacer" />
              {capabilities?.audioTrackSelection !== false && audioTracks.length > 0 && (
                <TrackButton
                  tvMode={tvMode}
                  focusKey="AIR_VIDEO_AUDIO"
                  label="Audio"
                  tracks={audioTracks}
                  onPress={() => cycleTrack('audio')}
                />
              )}
              {capabilities?.subtitleTrackSelection !== false && subtitleTracks.length > 0 && (
                <TrackButton
                  tvMode={tvMode}
                  focusKey="AIR_VIDEO_SUBTITLES"
                  label="CC"
                  tracks={subtitleTracks}
                  allowOff
                  onPress={() => cycleTrack('subtitle')}
                />
              )}
              {tvMode && capabilities?.videoZoom !== false ? (
                <FocusableButton
                  tvMode
                  focusKey="AIR_VIDEO_ZOOM"
                  className="tvp-text-button"
                  aria-label={`Video zoom ${zoom.toFixed(1)} times`}
                  onPress={cycleZoom}
                >
                  {zoom === 1 ? 'Zoom' : `${zoom.toFixed(1)}×`}
                </FocusableButton>
              ) : !tvMode && capabilities?.videoFit !== false ? (
                <FocusableButton
                  tvMode={false}
                  focusKey="AIR_VIDEO_FIT"
                  className="tvp-text-button"
                  onPress={cycleFit}
                >
                  {fit === 'fit' ? 'Fit' : 'Fill'}
                </FocusableButton>
              ) : null}
              {capabilities?.volume !== false && <div className="tvp-volume-group">
                <VolumeIcon />
                <FocusableSlider
                  tvMode={tvMode}
                  focusKey="AIR_VIDEO_VOLUME"
                  className="tvp-volume"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  aria-label="Volume"
                  onChange={(event) => changeVolume(Number(event.currentTarget.value))}
                  onTvLeft={() => changeVolume(volume - 0.05)}
                  onTvRight={() => changeVolume(volume + 0.05)}
                />
              </div>}
              {!tvMode && (
                <FocusableButton
                  tvMode={false}
                  focusKey="AIR_VIDEO_FULLSCREEN"
                  className="tvp-icon"
                  aria-label="Fullscreen"
                  onPress={() => void toggleFullscreen()}
                >
                  <FullscreenIcon />
                </FocusableButton>
              )}
            </div>
        </ControlContainer>
      )}
    </div>
  )
}

export function TvVideoPlayer(props: Omit<VideoPlayerProps, 'tvMode'>) {
  return <VideoPlayer {...props} tvMode />
}

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  if (typeof reason === 'string') return new Error(reason)
  if (typeof reason === 'object' && reason) {
    for (const key of ['message', 'error', 'detail', 'cause'] as const) {
      if (key in reason) {
        const value: unknown = (reason as Record<string, unknown>)[key]
        if (value !== reason) return toError(value)
      }
    }
    try { return new Error(JSON.stringify(reason)) }
    catch { /* fall through */ }
  }
  return new Error(String(reason))
}

const EMPTY_MEDIA: MediaInfo = { seekable: true, live: false, tracks: [], chapters: [] }

/**
 * Field-level media comparison. `MediaInfo` snapshots are replaced rather than
 * mutated, so equal field values mean an unchanged render input.
 */
function mediaChanged(latest: MediaInfo, previous: MediaInfo | undefined): boolean {
  return !previous
    || latest.tracks !== previous.tracks
    || latest.chapters !== previous.chapters
    || latest.durationSeconds !== previous.durationSeconds
    || latest.seekable !== previous.seekable
    || latest.live !== previous.live
    || latest.seekableStartSeconds !== previous.seekableStartSeconds
    || latest.seekableEndSeconds !== previous.seekableEndSeconds
    || latest.container !== previous.container
}

function liveTimeLabel(currentTime: number, liveEdge: number): string {
  const offset = Math.max(0, liveEdge - currentTime)
  return offset <= 3 ? 'Live' : `${formatTime(offset)} behind live`
}

function formatLiveTime(currentTime: number, liveEdge: number): ReactNode {
  const offset = Math.max(0, liveEdge - currentTime)
  if (offset <= 3) return 'LIVE'
  return <>-{formatTime(offset)} <span>/</span> LIVE</>
}
