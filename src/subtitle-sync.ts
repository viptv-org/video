import type { CaptionCue } from './captions';

export interface SubtitleSyncRecord {
  version: 1;
  playback_generation: string;
  media_identity: string;
  audio_identity: string;
  subtitle_hash: string;
  algorithm_version: string;
  revision: number;
  state: 'observing' | 'accepted' | 'ambiguous' | 'unavailable';
  manual: boolean;
  correction: { anchorUs: number; offsetUs: number; scale: number } | null;
}
export interface SubtitleWindow { readonly texts: readonly string[]; readonly deferred: boolean; }
const MAX_CUES = 4096;
const MAX_ACTIVE = 32;
const MAX_VISITS = 128;

export class SubtitleSyncView {
  private readonly cues: readonly CaptionCue[];
  private readonly prefixEnd: readonly number[];
  private record?: SubtitleSyncRecord;
  private seenRevision = 0;
  private identity?: { media: string; audio: string };
  private manualSeconds = 0;
  private frozen = false;
  private disposed = false;
  private pending?: SubtitleSyncRecord;

  constructor(cues: readonly CaptionCue[], private readonly generation: string, private readonly subtitleHash: string) {
    if (cues.length > MAX_CUES || cues.some(c => !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start || c.text.length > 4096) || cues.some((c, i) => i > 0 && c.start < cues[i - 1].start)) throw new Error('Subtitle window exceeds its supported bounds.');
    this.cues = cues.map(c => ({ ...c }));
    let end = -Infinity;
    this.prefixEnd = this.cues.map(c => end = Math.max(end, c.end));
  }
  accept(record: SubtitleSyncRecord): boolean {
    if (this.disposed || record.version !== 1 || record.playback_generation !== this.generation || record.subtitle_hash !== this.subtitleHash || record.algorithm_version !== 'activity-offset-affine-v1' || !Number.isSafeInteger(record.revision) || record.revision <= this.seenRevision) return false;
    if (this.identity && (this.identity.media !== record.media_identity || this.identity.audio !== record.audio_identity)) return false;
    this.seenRevision = record.revision;
    this.identity = { media: record.media_identity, audio: record.audio_identity };
    if (this.frozen || record.manual || record.state !== 'accepted' || !record.correction) return false;
    const c = record.correction;
    if (!Number.isSafeInteger(c.anchorUs) || !Number.isSafeInteger(c.offsetUs) || Math.abs(c.offsetUs) > 30_000_000 || !Number.isFinite(c.scale) || c.scale < 0.98 || c.scale > 1.02) return false;
    this.pending = { ...record, correction: { ...c } };
    return true;
  }
  manualDelay(seconds: number): void {
    if (!Number.isFinite(seconds) || Math.abs(seconds) > 120) throw new Error('Invalid subtitle delay.');
    this.manualSeconds = seconds; this.frozen = true; this.pending = undefined;
  }
  resume(): void { this.frozen = false; }
  at(playerSeconds: number, originSeconds: number): SubtitleWindow {
    if (this.disposed || !Number.isFinite(playerSeconds) || !Number.isFinite(originSeconds)) return { texts: [], deferred: true };
    let result = this.lookup(this.subtitleTime(playerSeconds + originSeconds));
    if (this.pending && result.texts.length === 0 && !result.deferred) {
      this.record = this.pending; this.pending = undefined;
      result = this.lookup(this.subtitleTime(playerSeconds + originSeconds));
    }
    return result;
  }
  private subtitleTime(titleSeconds: number): number {
    const c = this.record?.correction;
    return c ? c.anchorUs / 1e6 + (titleSeconds - c.anchorUs / 1e6 - c.offsetUs / 1e6 - this.manualSeconds) / c.scale : titleSeconds - this.manualSeconds;
  }
  private lookup(time: number): SubtitleWindow {
    let lo = 0, hi = this.cues.length;
    while (lo < hi) { const middle = (lo + hi) >>> 1; if (this.cues[middle].start <= time) lo = middle + 1; else hi = middle; }
    const texts: string[] = [];
    let visits = 0;
    for (let index = lo - 1; index >= 0 && this.prefixEnd[index] > time; index--) {
      if (++visits > MAX_VISITS) return { texts: [], deferred: true };
      const cue = this.cues[index];
      if (time < cue.end) { texts.push(cue.text); if (texts.length > MAX_ACTIVE) return { texts: [], deferred: true }; }
    }
    return { texts: texts.reverse(), deferred: false };
  }
  dispose(): void { this.disposed = true; this.pending = undefined; }
}
