/** Internal helpers shared by adapters; not part of the package API. */

/** ISO language matching without importing browser demux/track machinery. */
export const mediaLanguage = (language: string) => ({ en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', ja: 'jpn', ko: 'kor', zh: 'zho', hi: 'hin', ar: 'ara' }[language.split('-')[0]] ?? language);

export function supportsNativeHls(media: { canPlayType?(type: string): string }): boolean {
  return ['application/vnd.apple.mpegurl', 'application/x-mpegURL'].some(type => {
    try { return !!media.canPlayType?.(type); } catch { return false; }
  });
}

/** A finite positive value, otherwise zero. */
export function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
