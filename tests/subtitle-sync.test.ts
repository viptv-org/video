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
    view.resume(); expect(view.accept(record(3))).toBe(true);
    view.dispose(); expect(view.accept(record(4))).toBe(false);
  });
  it('defers dense/adversarial tracks without scanning or mutating the full track', () => {
    const view = new SubtitleSyncView(Array.from({ length: 4096 }, (_, i) => ({ start: i, end: 5000, text: String(i) })), 'generation', 'hash');
    expect(view.at(4500, 0)).toEqual({ texts: [], deferred: true });
    expect(() => new SubtitleSyncView(Array.from({ length: 4097 }, () => ({ start: 0, end: 1, text: 'x' })), 'g', 'h')).toThrow();
  });
});

const fixed = (revision = 1, seconds = 2): SubtitleSyncRecord => ({ ...record(revision), correction: { anchorUs: 0, offsetUs: seconds * 1e6, scale: 1 } });
const continuous = (overlap = 0) => new SubtitleSyncView(Array.from({ length: 100 }, (_, i) => ({ start: i, end: i + 1 + overlap, text: String(i) })), 'generation', 'hash');

for (const overlap of [0, 0.25]) it(`applies an accepted correction within five content seconds with ${overlap ? 'overlapping' : 'back-to-back'} cues`, () => {
  const view = continuous(overlap);
  view.at(10.1, 0); expect(view.accept(fixed())).toBe(true);
  expect(view.at(15.099, 0).texts).toEqual(overlap ? ['14', '15'] : ['15']);
  expect(view.at(15.1, 0).texts).toEqual(overlap ? ['12', '13'] : ['13']);
});

it('coalescing accepted revisions does not restart the five-second swap bound', () => {
  const view = continuous(); view.at(10.25, 0); view.accept(fixed());
  expect(view.at(12.25, 0).texts).toEqual(['12']);
  expect(view.accept(fixed(2, 3))).toBe(true);
  expect(view.at(15.25, 0).texts).toEqual(['12']);
});

it('pause and origin-only rebasing do not advance content wait, while forward seeks retain valid mapping', () => {
  const view = continuous(); view.at(10, 60); view.accept(fixed());
  for (let tick = 0; tick < 100; tick++) expect(view.at(5, 65).texts).toEqual(['70']);
  expect(view.at(9.999, 65).texts).toEqual(['74']);
  expect(view.at(10, 65).texts).toEqual(['73']);
  expect(view.at(22.5, 65).texts).toEqual(['85']);
  const forward = continuous(); forward.at(10.25, 0); forward.accept(fixed());
  expect(forward.at(30.25, 0).texts).toEqual(['28']);
});

it('a backward seek reanchors an unapplied wait without discarding or multiplying the correction', () => {
  const view = continuous(); view.at(10.25, 0); view.accept(fixed()); view.at(12.25, 0);
  expect(view.at(3.25, 0).texts).toEqual(['3']);
  expect(view.at(8.249, 0).texts).toEqual(['8']);
  expect(view.at(8.25, 0).texts).toEqual(['6']);
  expect(view.at(30.25, 0).texts).toEqual(['28']);
});

it('manual freeze and disposal retire a pending timed swap', () => {
  const view = continuous(); view.at(10.25, 0); view.accept(fixed()); view.manualDelay(1);
  expect(view.at(20.25, 0).texts).toEqual(['19']);
  view.resume(); expect(view.at(30.25, 0).texts).toEqual(['29']);
  view.accept(fixed(2)); view.dispose();
  expect(view.at(40.25, 0)).toEqual({ texts: [], deferred: true });
  expect(view.accept(fixed(3))).toBe(false);
  const remote = continuous(); remote.at(10.25, 0); remote.accept(fixed());
  expect(remote.accept({ ...fixed(2), manual: true })).toBe(false);
  expect(remote.at(20.25, 0).texts).toEqual(['20']);
});

it('malformed accepted records cannot poison identity, revision or an existing pending correction', () => {
  for (const correction of [null, { anchorUs: 0, offsetUs: 31e6, scale: 1 }, { anchorUs: 0.5, offsetUs: 0, scale: 1 }, { anchorUs: 0, offsetUs: 0, scale: NaN }]) {
    const view = continuous();
    expect(view.accept({ ...fixed(99), media_identity: 'poison-media', audio_identity: 'poison-audio', correction })).toBe(false);
    expect(view.accept(fixed())).toBe(true);
  }
  const view = continuous(); view.at(10.25, 0); view.accept(fixed());
  expect(view.accept({ ...fixed(99), audio_identity: '' })).toBe(false);
  expect(view.accept({ ...fixed(99), correction: { anchorUs: 0, offsetUs: 0, scale: Infinity } })).toBe(false);
  expect(view.accept({ ...fixed(99), audio_identity: 'other-dub' })).toBe(false);
  expect(view.accept(fixed(2, 3))).toBe(true);
  expect(view.at(15.25, 0).texts).toEqual(['12']);
});
