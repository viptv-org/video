export type NativeVideoPlatform = 'linux' | 'windows';

/**
 * The native playback engine a host may request. 'auto' follows the plugin's
 * documented preference order — mpv first on Linux when its runtime was
 * compiled — so hosts without an opinion get the engine the plugin prefers.
 */
export type NativeVideoEngine = 'auto' | 'mpv' | 'gstreamer';

/** The host-side command surface of tauri-plugin-video, injectable for tests. */
export interface TauriVideoInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface NativeVideoDiagnostics {
  readonly protocolVersion: number;
  readonly crateName: string;
  readonly crateVersion: string;
  readonly platform: string;
  /** The playback engines compiled into the build, in preference order. */
  readonly engines?: readonly string[];
}

export interface NativeVideoTrack {
  readonly id: string;
  readonly index: number;
  readonly kind: 'video' | 'audio' | 'subtitle';
  readonly language: string;
  readonly label: string;
  readonly codec: string;
  readonly selected: boolean;
}

export interface NativeVideoSnapshot {
  readonly durationSeconds: number;
  readonly currentTimeSeconds: number;
  readonly bufferedSeconds: number;
  readonly live?: boolean;
  readonly seekable?: boolean;
  readonly seekableStartSeconds?: number;
  readonly seekableEndSeconds?: number;
  readonly playing: boolean;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly tracks: readonly NativeVideoTrack[];
  readonly presentedFrames?: number;
  readonly droppedFrames?: number;
  readonly measuredFps?: number;
  readonly hardwareBackend?: string;

  /** The engine serving this snapshot, e.g. 'mpv' or 'gstreamer'. */
  readonly backend?: string;
}

export interface NativeWireError {
  readonly code: string;
  readonly message: string;
}
