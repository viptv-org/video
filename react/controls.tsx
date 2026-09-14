import {
  FocusContext,
  init,
  setFocus,
  useFocusable,
} from '@noriginmedia/norigin-spatial-navigation'
import {
  type ButtonHTMLAttributes,
  type ForwardedRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type Ref,
  type RefCallback,
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useRef,
} from 'react'

import {
  registerVideoControls,
  VIDEO_CONTROLS_ATTRIBUTE,
  type MediaTrack,
} from '../guest-js/index'

export const VIDEO_CONTROLS_PROPS = { [VIDEO_CONTROLS_ATTRIBUTE]: '' }

let spatialNavigationInitialized = false

/** Initialize Norigin once when the first TV player mounts. */
function initializeTvNavigation(): void {
  if (spatialNavigationInitialized) return
  init({
    debug: false,
    visualDebug: false,
    throttle: 80,
    throttleKeypresses: true,
    shouldFocusDOMNode: true,
  })
  spatialNavigationInitialized = true
}

/** Marks controls mounted anywhere in the React tree as intentional player UI. */
export function useVideoControlRegion<T extends HTMLElement = HTMLDivElement>(): RefCallback<T> {
  const cleanupRef = useRef<(() => void) | undefined>(undefined)
  return useCallback((node: T | null) => {
    cleanupRef.current?.()
    cleanupRef.current = node ? registerVideoControls(node) : undefined
  }, [])
}

export interface VideoControlRegionProps extends HTMLAttributes<HTMLDivElement> {}

/** A framework-owned control region that may be placed anywhere in the page. */
export const VideoControlRegion = forwardRef(function VideoControlRegion(
  { children, ...props }: VideoControlRegionProps,
  forwardedRef: ForwardedRef<HTMLDivElement>,
) {
  const controlRef = useVideoControlRegion<HTMLDivElement>()
  return (
    <div {...props} ref={mergeRefs(forwardedRef, controlRef)} {...VIDEO_CONTROLS_PROPS}>
      {children}
    </div>
  )
})

interface FocusableButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tvMode: boolean
  focusKey: string
  onPress: () => void
}

export function FocusableButton({ tvMode, focusKey, onPress, children, ...props }: FocusableButtonProps) {
  return tvMode
    ? <TvFocusableButton focusKey={focusKey} onPress={onPress} {...props}>{children}</TvFocusableButton>
    : <VideoButton onPress={onPress} {...props}>{children}</VideoButton>
}

function TvFocusableButton({ focusKey, onPress, children, ...props }: Omit<FocusableButtonProps, 'tvMode'>) {
  const { ref, focused } = useFocusable<Record<string, never>, HTMLButtonElement>({
    focusKey,
    onEnterPress: onPress,
  })
  return <VideoButton controlRef={ref} focused={focused} onPress={onPress} {...props}>
    {children}
  </VideoButton>
}

function VideoButton({
  controlRef,
  focused,
  onPress,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  controlRef?: Ref<HTMLButtonElement>
  focused?: boolean
  onPress: () => void
}) {
  return <button {...props} ref={controlRef} type="button" data-focused={focused || undefined} onClick={(event) => {
    props.onClick?.(event)
    onPress()
  }}>{children}</button>
}

interface FocusableSliderProps extends InputHTMLAttributes<HTMLInputElement> {
  tvMode: boolean
  focusKey: string
  onTvLeft: () => void
  onTvRight: () => void
}

export function FocusableSlider({ tvMode, focusKey, onTvLeft, onTvRight, ...props }: FocusableSliderProps) {
  return tvMode
    ? <TvFocusableSlider focusKey={focusKey} onTvLeft={onTvLeft} onTvRight={onTvRight} {...props} />
    : <RangeInput {...props} />
}

function TvFocusableSlider({
  focusKey,
  onTvLeft,
  onTvRight,
  ...props
}: Omit<FocusableSliderProps, 'tvMode'>) {
  const { ref, focused } = useFocusable<Record<string, never>, HTMLInputElement>({
    focusKey,
    onArrowPress: (direction) => {
      if (direction === 'left') onTvLeft()
      else if (direction === 'right') onTvRight()
      else return true
      return false
    },
  })
  return <RangeInput controlRef={ref} focused={focused} {...props} />
}

function RangeInput({
  controlRef,
  focused,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  controlRef?: Ref<HTMLInputElement>
  focused?: boolean
}) {
  return <input {...props} ref={controlRef} type="range" data-focused={focused || undefined} />
}

export function ControlContainer({
  tvMode,
  focusResetKey,
  children,
}: {
  tvMode: boolean
  focusResetKey?: string | number
  children: ReactNode
}) {
  if (tvMode) return <TvControlContainer focusResetKey={focusResetKey}>{children}</TvControlContainer>
  return <Controls>{children}</Controls>
}

function TvControlContainer({
  focusResetKey,
  children,
}: {
  focusResetKey?: string | number
  children: ReactNode
}) {
  initializeTvNavigation()
  const { ref, focusKey } = useFocusable<Record<string, never>, HTMLDivElement>({
    focusKey: 'AIR_VIDEO_CONTROLS',
    trackChildren: true,
    preferredChildFocusKey: 'AIR_VIDEO_PLAY',
    saveLastFocusedChild: true,
    isFocusBoundary: true,
  })
  useEffect(() => {
    const timer = window.setTimeout(() => setFocus('AIR_VIDEO_PLAY'), 0)
    return () => window.clearTimeout(timer)
  }, [focusResetKey])
  return (
    <FocusContext.Provider value={focusKey}>
      <Controls controlRef={ref}>{children}</Controls>
    </FocusContext.Provider>
  )
}

function Controls({ controlRef, children }: { controlRef?: Ref<HTMLDivElement>; children: ReactNode }) {
  return <div ref={controlRef} className="tvp-controls" aria-label="Playback controls" {...VIDEO_CONTROLS_PROPS}>
    {children}
  </div>
}

export function TrackButton({
  tvMode,
  focusKey,
  label,
  tracks,
  allowOff = false,
  onPress,
}: {
  tvMode: boolean
  focusKey: string
  label: string
  tracks: MediaTrack[]
  allowOff?: boolean
  onPress: () => void
}) {
  const selected = tracks.find((track) => track.selected)
  const language = selected?.language?.toUpperCase()
  const value = language && language !== 'UND'
    ? language
    : selected?.label ?? (allowOff ? 'Off' : 'Default')
  const description = selected?.label && selected.label !== value
    ? `${value}, ${selected.label}`
    : value
  return (
    <FocusableButton
      tvMode={tvMode}
      focusKey={focusKey}
      className="tvp-track-button"
      aria-label={`${label}: ${description}. Press to change.`}
      onPress={onPress}
    >
      <strong>{label}</strong><span>{value}</span>
    </FocusableButton>
  )
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    }
  }
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const tail = `${hours ? String(minutes).padStart(2, '0') : minutes}:${String(total % 60).padStart(2, '0')}`
  return hours ? `${hours}:${tail}` : tail
}

export function formatBuffer(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Buffering'
  return `${Math.floor(seconds)}s buffered`
}

export function PlayIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
}

export function PauseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z" /></svg>
}

export function VolumeIcon() {
  return <svg className="tvp-volume-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5-.5a5 5 0 0 1 0 7M18.8 6a8 8 0 0 1 0 12" /></svg>
}

export function FullscreenIcon() {
  return <svg className="tvp-outline" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /></svg>
}
