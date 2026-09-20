import type { PlaybackCapabilities, PlayerCapabilities } from '../types';

export const TAURI_NATIVE_PLAYER_CAPABILITIES: PlayerCapabilities = {
  platform: 'tauri',
  engine: 'tauri-plugin-video (native GStreamer)',
  directNative: 'supported',
  adaptiveStreaming: 'supported',
  drm: 'unsupported',
  canSetVolume: true,
  canPause: true,
  canSeek: true,
  canSelectAudioTrack: true,
  canSelectTextTrack: true,
  canDisableTextTrack: true,
  canUseCookies: true,
  canUseUserAgent: true,
  limitations: [
    'Native engine, codec and HDR support are runtime facts of the installed GStreamer build; the delivery profile only declares what the engine is expected to play.',
    'The native command protocol exposes no playback-rate change and no buffering signal; neither is reported or emulated.',
    'Cookies and a user agent are engine request properties, not arbitrary header support.',
    'Live windows are playable but expose no VOD seek bar, matching the other adapters.',
  ],
};

/**
 * The desktop no-transcode delivery profile handed to the backend's session
 * ladder: a broad native codec and container set with direct delivery
 * preferred. The server's own container, single-stream and HDR rules still
 * decide the rung; this client never requests managed-only or forced output.
 */
export const TAURI_NATIVE_DELIVERY_CAPABILITIES: PlaybackCapabilities = {
  maxWidth: 3840,
  maxHeight: 2160,
  h264: true,
  hevc: true,
  aac: true,
  hevcSdr: true,
  directPlay: true,
  directUrls: true,
  directMp4: true,
  directHls: true,
  directFiles: true,
  directVideoCodecs: ['avc', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg2video', 'mpeg4', 'theora', 'prores', 'mjpeg'],
  directAudioCodecs: ['aac', 'opus', 'mp3', 'vorbis', 'flac', 'ac3', 'eac3', 'dts', 'truehd', 'pcm'],
};
