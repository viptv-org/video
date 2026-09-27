import type { Input, InputAudioTrack, InputVideoTrack } from 'mediabunny';
import type { OpenPlayerRequest, PlayerQuality, PlayerTrack } from './types';

export const trackId = (type: string, id: number) => `${type}:${id}`;
export const mediaLanguage = (language: string) => ({ en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', ja: 'jpn', ko: 'kor', zh: 'zho', hi: 'hin', ar: 'ara' }[language.split('-')[0]] ?? language);
export async function audioChoices(video: InputVideoTrack): Promise<{ tracks: InputAudioTrack[]; choices: PlayerTrack[] }> {
  const tracks = await video.getPairableAudioTracks();
  const choices = await Promise.all(tracks.map(async (track) => ({
    id: trackId('audio', track.id), label: await track.getName() || await track.getLanguageCode() || `Audio ${track.number}`,
    language: await track.getLanguageCode(), available: true,
    codec: await track.getCodec() ?? undefined,
  })));
  return { tracks, choices };
}
export async function chooseAudio(video: InputVideoTrack, request: OpenPlayerRequest): Promise<InputAudioTrack | null> {
  const tracks = await video.getPairableAudioTracks();
  if (request.audioTrackId) {
    const track = tracks.find(t => trackId('audio', t.id) === request.audioTrackId);
    if (track) return track;
  }
  if (request.preferredAudioLanguage) {
    for (const track of tracks) if (mediaLanguage(await track.getLanguageCode()) === mediaLanguage(request.preferredAudioLanguage)) return track;
  }
  return video.getPrimaryPairableAudioTrack();
}
export async function videoChoices(input: Input): Promise<{ tracks: InputVideoTrack[]; choices: PlayerQuality[] }> {
  const tracks = await input.getVideoTracks({ filter: async track => !(await track.hasOnlyKeyPackets()) });
  const choices = await Promise.all(tracks.map(async track => {
    const height = await track.getDisplayHeight();
    return { id: trackId('video', track.id), label: `${height}p`, width: await track.getDisplayWidth(), height,
      bitrate: await track.getAverageBitrate() || await track.getBitrate() || 0 };
  }));
  return { tracks, choices };
}

/** Conservative EWMA: cached/tiny transfers do not inflate the sustainable rate. */
export class AdaptiveQuality {
  private slow = 0;
  private fast = 0;
  private upgradeSince = 0;
  sample(bytes: number, seconds: number): void {
    if (bytes < 65536 || seconds < 0.03) return;
    const rate = bytes * 8 / seconds;
    const ewma = (old: number, halfLife: number) => old ? old + (1 - Math.pow(0.5, seconds / halfLife)) * (rate - old) : rate;
    this.fast = ewma(this.fast, 3); this.slow = ewma(this.slow, 10);
  }
  choose(qualities: readonly PlayerQuality[], current: string, bufferedSeconds: number, now: number): string {
    const sorted = [...qualities].sort((a, b) => a.bitrate - b.bitrate || a.height - b.height);
    const at = sorted.findIndex(q => q.id === current);
    if (at < 0 || !sorted.length) return current;
    const budget = Math.min(this.slow, this.fast) * 0.8;
    const eligible = sorted.filter(q => q.bitrate > 0 && q.bitrate <= budget);
    const best = budget ? eligible[eligible.length - 1] ?? sorted[0] : sorted[at];
    if (bufferedSeconds < 0.03 && at > 0) { this.upgradeSince = 0; return sorted[at - 1].id; }
    if (sorted.indexOf(best) < at) { this.upgradeSince = 0; return best.id; }
    if (sorted.indexOf(best) > at && bufferedSeconds >= 0.025) {
      this.upgradeSince ||= now;
      if (now - this.upgradeSince >= 10000) { this.upgradeSince = 0; return sorted[at + 1].id; }
    } else this.upgradeSince = 0;
    return current;
  }
}
