import {
  TAURI_VIDEO_PROTOCOL_VERSION,
  TauriNativeAdapter,
  type NativeVideoDiagnostics,
  type NativeVideoEngine,
  type NativeVideoSnapshot,
  type NativeVideoTrack,
} from '../src/tauri-native';

export function baseSnapshot(overrides: Partial<NativeVideoSnapshot> = {}): NativeVideoSnapshot {
  return {
    durationSeconds: 600,
    currentTimeSeconds: 0,
    bufferedSeconds: 240,
    live: false,
    seekable: true,
    seekableStartSeconds: 0,
    seekableEndSeconds: 600,
    playing: false,
    videoWidth: 1920,
    videoHeight: 1080,
    tracks: [
      { id: 'video-0', index: 0, kind: 'video', language: '', label: '', codec: 'h264', selected: true },
      { id: 'audio-1', index: 1, kind: 'audio', language: 'eng', label: 'English', codec: 'aac', selected: true },
      { id: 'text-2', index: 2, kind: 'subtitle', language: 'spa', label: 'Spanish', codec: 'subrip', selected: false },
    ],
    ...overrides,
  };
}

export function last<T>(values: readonly T[]): T {
  return values[values.length - 1];
}

/** Records every plugin command and answers the way the Rust engine would. */
export class FakeTauriVideoPlugin {
  diagnostics: NativeVideoDiagnostics = {
    protocolVersion: TAURI_VIDEO_PROTOCOL_VERSION,
    crateName: 'tauri-plugin-video',
    crateVersion: '0.4.0',
    platform: 'linux',
  };
  openSnapshot: NativeVideoSnapshot = baseSnapshot({ playing: true });
  openError: unknown;

  /** Per-attempt open errors, consumed front-first; the persistent openError applies after the queue empties. */
  openErrorQueue: unknown[] = [];
  controlError: unknown;
  statsSnapshot: NativeVideoSnapshot | undefined;
  statsError: unknown;
  readonly openedPayloads: Array<Record<string, unknown>> = [];
  readonly controls: Array<{ sessionKey: string; action: string; value: number; index: number }> = [];
  readonly layouts: Array<Record<string, unknown>> = [];
  readonly closedKeys: string[] = [];
  #current = 0;
  #playing = false;
  #tracks: readonly NativeVideoTrack[] = baseSnapshot().tracks;

  readonly commands: string[] = [];
  /** When set, the engine answers seeks by replaying from ~0: an origin that cannot serve range requests. */
  seekReplaysFromBeginning = false;

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.commands.push(command);
    if (command === 'plugin:video|native_diagnostics') return this.diagnostics as T;
    if (command === 'plugin:video|native_open') {
      const payload = (args?.payload ?? {}) as Record<string, unknown>;
      this.openedPayloads.push(payload);
      const failure = this.openErrorQueue.length > 0 ? this.openErrorQueue.shift() : this.openError;
      if (failure) throw failure;
      this.#playing = payload.autoplay === true;
      this.#current = 0;
      this.#tracks = this.openSnapshot.tracks;
      return this.openSnapshot as T;
    }
    if (command === 'plugin:video|native_control') {
      const payload = (args?.payload ?? {}) as { sessionKey: string; action: string; value: number; index: number };
      this.controls.push(payload);
      if (this.controlError) throw this.controlError;
      this.#apply(payload.action, payload.value, payload.index);
      return this.#snapshot() as T;
    }
    if (command === 'plugin:video|native_stats') {
      if (this.statsError) throw this.statsError;
      return (this.statsSnapshot ?? this.#snapshot()) as T;
    }
    if (command === 'plugin:video|native_layout') {
      this.layouts.push((args?.payload ?? {}) as Record<string, unknown>);
      return null as T;
    }
    if (command === 'plugin:video|native_close') {
      this.closedKeys.push(((args?.payload ?? {}) as { sessionKey: string }).sessionKey);
      return null as T;
    }
    throw new Error(`unexpected command ${command}`);
  }

  #apply(action: string, value: number, index: number): void {
    if (action === 'play') this.#playing = true;
    else if (action === 'pause') this.#playing = false;
    else if (action === 'seek') this.#current = this.seekReplaysFromBeginning ? 1.0 : value;
    else if (action === 'track') {
      this.#tracks = this.#tracks.map(track => track.index === index ? { ...track, selected: true } : track);
    } else if (action === 'deselectTrack') {
      this.#tracks = this.#tracks.map(track => track.index === index ? { ...track, selected: false } : track);
    }
  }

  #snapshot(): NativeVideoSnapshot {
    return {
      ...this.openSnapshot,
      currentTimeSeconds: this.#current,
      bufferedSeconds: Math.max(this.#current, this.openSnapshot.bufferedSeconds),
      playing: this.#playing,
      tracks: this.#tracks,
    };
  }
}

export function createAdapter(
  plugin: FakeTauriVideoPlugin,
  options: { engine?: NativeVideoEngine } = {},
): { player: TauriNativeAdapter; anchor: HTMLVideoElement } {
  const anchor = document.createElement('video');
  return { player: new TauriNativeAdapter(anchor, plugin, { platform: 'linux', engine: options.engine }), anchor };
}
