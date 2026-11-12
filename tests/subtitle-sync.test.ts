import { describe, expect, it } from 'vitest';
import { SubtitleSyncView, type SubtitleSyncRecord } from '../src/subtitle-sync';
const record = (revision = 1): SubtitleSyncRecord => ({ version: 1, playback_generation: 'generation', media_identity: 'session', audio_identity: 'audio', subtitle_hash: 'hash', algorithm_version: 'activity-offset-affine-v1', revision, state: 'accepted', manual: false, correction: { anchorUs: 600e6, offsetUs: 2e6, scale: 1.001 } });
describe('bounded subtitle correction', () => {
  it('uses canonical cues, affine anchor and the single effective origin through seeks', () => {
    const view = new SubtitleSyncView([{ start: 650, end: 651, text: 'dialogue' }], 'generation', 'hash');
    expect(view.accept(record())).toBe(true);
    view.at(580, 60);
    expect(view.at(592.05, 60).texts).toEqual(['dialogue']);
    expect(view.at(591.9, 60).texts).toEqual([]);
    expect(view.at(592.05, 60).texts).toEqual(['dialogue']);
    expect(view.at(650, 60).texts).toEqual([]);
  });
  it('waits for a cue gap, rejects stale identity and freezes manual changes', () => {
    const view = new SubtitleSyncView([{ start: 650, end: 651, text: 'dialogue' }], 'generation', 'hash');
    view.accept(record());
    expect(view.at(590.5, 60).texts).toEqual(['dialogue']);
    expect(view.accept(record())).toBe(false);
    view.at(589, 60);
    expect(view.accept({ ...record(2), audio_identity: 'dub' })).toBe(false);
    view.manualDelay(1);
    expect(view.accept(record(2))).toBe(false);
    expect(view.at(593.05, 60).texts).toEqual(['dialogue']);
    view.resume(); expect(view.accept(record(2))).toBe(true);
    view.dispose(); expect(view.accept(record(3))).toBe(false);
  });
  it('defers dense/adversarial tracks without scanning or mutating the full track', () => {
    const view = new SubtitleSyncView(Array.from({ length: 4096 }, (_, i) => ({ start: i, end: 5000, text: String(i) })), 'generation', 'hash');
    expect(view.at(4500, 0)).toEqual({ texts: [], deferred: true });
    expect(() => new SubtitleSyncView(Array.from({ length: 4097 }, () => ({ start: 0, end: 1, text: 'x' })), 'g', 'h')).toThrow();
  });
});
