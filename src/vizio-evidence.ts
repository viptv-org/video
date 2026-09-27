import type { PlaybackEngineEvidence } from './types';

/** Physical Conjure evidence, 2026-09-27. Firmware/engine changes invalidate it.
 * H.264: 1080p30/60; HEVC Main/Main10: 2160p24 SDR. No HDR claim.
 * See the media qualification report; frame callbacks are not usable on this firmware.
 */
export function qualifiedVizioEvidence(userAgent: string, mseTypeSupported: (mime: string) => boolean): PlaybackEngineEvidence[] {
  if (!userAgent.includes('Model/V655-G9') || !userAgent.includes('FW/2.600.596.0-10') || !userAgent.includes('Conjure/MTKB-7.600.259.0-prod')) return [];
  const entries: PlaybackEngineEvidence[] = [];
  if (mseTypeSupported('video/mp4; codecs="avc1.64002a"')) entries.push({ engine: 'mse', codec: 'avc', profile: 'High', maxLevel: 42, containers: ['mp4', 'cmaf'], evidence: 'decoded', maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, bitDepth: 8, hdr: false });
  if (mseTypeSupported('video/mp4; codecs="hvc1.1.6.L150.B0"')) entries.push({ engine: 'mse', codec: 'hevc', profile: 'Main', maxLevel: 150, containers: ['mp4', 'cmaf'], evidence: 'decoded', maxWidth: 3840, maxHeight: 2160, maxFrameRate: 24, bitDepth: 8, hdr: false });
  if (mseTypeSupported('video/mp4; codecs="hvc1.2.4.L150.B0"')) entries.push({ engine: 'mse', codec: 'hevc', profile: 'Main 10', maxLevel: 150, containers: ['mp4', 'cmaf'], evidence: 'decoded', maxWidth: 3840, maxHeight: 2160, maxFrameRate: 24, bitDepth: 10, hdr: false });
  return entries;
}
