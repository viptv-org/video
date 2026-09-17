import Hls from 'hls.js';
import type { PlaybackCapabilities } from './types';

export const BROWSER_CODECS = {
  h264: 'video/mp4; codecs="avc1.640029"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L150.B0"',
  aac: 'audio/mp4; codecs="mp4a.40.2"',
} as const;
export const HLS_MIME_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegURL'] as const;
export interface BrowserProbeEnvironment {
  readonly media: { canPlayType(type: string): string };
  readonly decodingInfo?: (configuration: MediaDecodingConfiguration) => Promise<MediaCapabilitiesDecodingInfo>;
  readonly mseSupported: boolean;
  readonly mseTypeSupported: (type: string) => boolean;
  readonly timeoutMs?: number;
}
export interface BrowserPlaybackProbe {
  readonly capabilities: PlaybackCapabilities;
  readonly canPlayManagedHls: boolean;
  readonly protocols: { readonly nativeHls: boolean; readonly mseHls: boolean; readonly selectedHls: 'mediabunny' | 'native' | 'mse' | 'unsupported' };
  readonly evidence: readonly string[];
}
export function supportsNativeHls(media: { canPlayType?(type: string): string }): boolean {
  return HLS_MIME_TYPES.some((type) => { try { return !!media.canPlayType?.(type); } catch { return false; } });
}

/** Probe each executable decoding path separately; actual track preparation remains authoritative. */
export async function probeBrowserPlaybackCapabilities(environment?: BrowserProbeEnvironment, options: { mediabunny?: boolean } = {}): Promise<BrowserPlaybackProbe> {
  const source = typeof MediaSource === 'undefined' ? undefined : MediaSource;
  const env = environment ?? {
    media: document.createElement('video'),
    decodingInfo: navigator.mediaCapabilities?.decodingInfo.bind(navigator.mediaCapabilities),
    mseSupported: Hls.isSupported(),
    mseTypeSupported: (type: string) => source?.isTypeSupported(type) ?? false,
  };
  const evidence: string[] = [];
  const bunny = !environment && options.mediabunny ? await probeWebCodecs() : { h264: false, hevc: false, aac: false };
  const bunnyBaseline = bunny.h264 && bunny.aac;
  if (!environment && options.mediabunny) evidence.push(`mediabunny:webcodecs:h264=${bunny.h264};hevc=${bunny.hevc};aac=${bunny.aac}`);
  const nativeHls = supportsNativeHls(env.media);
  const mseHls = !nativeHls && env.mseSupported;
  const selectedHls = bunnyBaseline ? 'mediabunny' : nativeHls ? 'native' : mseHls ? 'mse' : 'unsupported';
  async function codec(name: keyof typeof BROWSER_CODECS, path: 'file' | 'media-source'): Promise<boolean> {
    const mime = BROWSER_CODECS[name];
    let hint = false;
    try { hint = path === 'file' ? !!env.media.canPlayType(mime) : env.mseTypeSupported(mime); } catch { /* unsupported API */ }
    if (!hint) { evidence.push(`${path}:${name}:mime-unsupported`); return false; }
    if (!env.decodingInfo) { evidence.push(`${path}:${name}:mime-supported; decodingInfo-unavailable`); return true; }
    const configuration: MediaDecodingConfiguration = name === 'aac'
      ? { type: path, audio: { contentType: mime, channels: '2', bitrate: 192000, samplerate: 48000 } }
      : { type: path, video: { contentType: mime, width: 1920, height: 1080, bitrate: 8000000, framerate: 30 } };
    // One bounded probe per configuration; null means the timeout won the race.
    const probe = async (candidate: MediaDecodingConfiguration): Promise<MediaCapabilitiesDecodingInfo | null> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(() => env.decodingInfo!(candidate)),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), env.timeoutMs ?? 1000); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    try {
      const result = await probe(configuration);
      if (result !== null && !result.supported && name !== 'aac') {
        // decodingInfo refuses the 1080p probe sample on hardware that still
        // decodes smaller frames, so video codecs re-probe at 720p before
        // reporting the browser incompatible; audio has no geometry to drop.
        const fallback = await probe({ type: path, video: { contentType: mime, width: 1280, height: 720, bitrate: 4000000, framerate: 30 } });
        evidence.push(`${path}:${name}:decodingInfo-unsupported-1080p; ${fallback === null ? 'decodingInfo-timeout-720p; mime-supported' : `${fallback.supported ? 'supported' : 'unsupported'}-720p`}`);
        return fallback === null ? hint : fallback.supported;
      }
      evidence.push(`${path}:${name}:${result === null ? 'decodingInfo-timeout; mime-supported' : `decodingInfo-${result.supported ? 'supported' : 'unsupported'}; smooth=${result.smooth}; powerEfficient=${result.powerEfficient}`}`);
      return result === null ? hint : result.supported;
    } catch {
      evidence.push(`${path}:${name}:decodingInfo-unavailable; mime-supported`);
      return hint;
    }
  }
  const [nativeH264, nativeHevc, nativeAac, mseH264, mseHevc, mseAac] = await Promise.all([
    codec('h264', 'file'), codec('hevc', 'file'), codec('aac', 'file'),
    mseHls ? codec('h264', 'media-source') : false,
    mseHls ? codec('hevc', 'media-source') : false,
    mseHls ? codec('aac', 'media-source') : false,
  ]);
  const h264 = bunnyBaseline || (nativeHls ? nativeH264 : mseHls && mseH264);
  const aac = bunnyBaseline || (nativeHls ? nativeAac : mseHls && mseAac);
  const hevc = (bunny.hevc && bunny.aac) || (nativeHevc && (nativeHls || (mseHls && mseHevc)));
  const directMp4 = bunnyBaseline || (nativeH264 && nativeAac);
  const canPlayManagedHls = h264 && aac;
  // A WebCodecs demuxer can read the original container (Matroska, MPEG-TS, the
  // ISO base media formats and more) instead of a server-remuxed HLS window, so
  // report that file path and the codecs it can decode.
  const { decodableCodecs } = bunnyBaseline && !environment && options.mediabunny
    ? await import('./mediabunny')
    : { decodableCodecs: undefined };
  const fileCodecs = decodableCodecs ? await decodableCodecs() : undefined;
  if (fileCodecs) evidence.push(`files:video=${fileCodecs.video.join('|')};audio=${fileCodecs.audio.join('|')}`);
  evidence.push(`hls:${selectedHls}`, 'sample:1080p30; h264-high-4.1; hevc-main-5.0-sdr; aac-lc-stereo');
  return {
    capabilities: {
      maxWidth: fileCodecs ? 3840 : 1920, maxHeight: fileCodecs ? 2160 : 1080,
      h264, hevc, aac, directPlay: directMp4 || canPlayManagedHls, hevcSdr: hevc, directMp4, directHls: canPlayManagedHls,
      directFiles: !!fileCodecs, directVideoCodecs: fileCodecs?.video, directAudioCodecs: fileCodecs?.audio,
    },
    canPlayManagedHls,
    protocols: { nativeHls, mseHls, selectedHls }, evidence,
  };
}

/** Only used by the browser adapter that actually consumes WebCodecs via Mediabunny. */
export async function probeWebCodecs(): Promise<{ h264: boolean; hevc: boolean; aac: boolean }> {
  if (!globalThis.isSecureContext || typeof VideoDecoder === 'undefined' || typeof AudioDecoder === 'undefined' || typeof AudioContext === 'undefined')
    return { h264: false, hevc: false, aac: false };
  const bounded = async (probe: () => Promise<{ supported?: boolean }>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(probe).then(result => result.supported === true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000); })]); }
    catch { return false; } finally { clearTimeout(timer); }
  };
  const [h264, hevc, aac] = await Promise.all([
    bounded(() => VideoDecoder.isConfigSupported({ codec: 'avc1.640029', codedWidth: 1920, codedHeight: 1080 })),
    bounded(() => VideoDecoder.isConfigSupported({ codec: 'hvc1.1.6.L150.B0', codedWidth: 1920, codedHeight: 1080 })),
    bounded(() => AudioDecoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 })),
  ]);
  return { h264, hevc, aac };
}
