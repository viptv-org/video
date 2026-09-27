import { afterEach, describe, expect, it, vi } from 'vitest';
import { mediaFailure, canChangeMediaPath } from '../src/browser-policy';
import { AdaptiveQuality } from '../src/media-tracks';
import { parseWebVtt } from '../src/captions';
import { sessionMediaFetch } from '../src/session-media-fetch';

afterEach(() => vi.unstubAllGlobals());
describe('browser delivery decisions', () => {
  it('keeps autoplay, authorization and connection failures out of the conversion ladder', async () => {
    expect(canChangeMediaPath(mediaFailure(new DOMException('gesture', 'NotAllowedError')))).toBe(false);
    expect(canChangeMediaPath(mediaFailure(new TypeError('network')))).toBe(false);
    for (const status of [401, 403, 410, 503]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));
      const result = await sessionMediaFetch(`${location.origin}/media/id/cap/source.bin`)(`${location.origin}/media/id/cap/source.bin`).catch(error => error);
      expect(canChangeMediaPath(result)).toBe(false);
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 406 })));
    const refusal = await sessionMediaFetch(`${location.origin}/media/id/cap/index.m3u8`)(`${location.origin}/media/id/cap/index.m3u8`).catch(error => error);
    expect(canChangeMediaPath(refusal)).toBe(true);
    expect(refusal.reason).toBe('container');
  });
  it('downshifts within the measured network budget and requires sustained headroom before an upgrade', () => {
    const quality = new AdaptiveQuality();
    const choices = [
      { id: 'low', label: '360p', height: 360, width: 640, bitrate: 1000000 },
      { id: 'high', label: '1080p', height: 1080, width: 1920, bitrate: 6000000 },
    ];
    quality.sample(1000000, 2);
    expect(quality.choose(choices, 'high', 1, 1000)).toBe('low');
    quality.sample(100000000, 10);
    expect(quality.choose(choices, 'low', 1, 2000)).toBe('low');
    expect(quality.choose(choices, 'low', 1, 13000)).toBe('high');
    expect(quality.choose(choices, 'high', 0, 14000)).toBe('low');
  });
  it('preserves sidecar timeline offsets and renders cue markup as plain text', () => {
    const cues = parseWebVtt('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000 align:center\n<b>Hello</b>\n', 60);
    expect(cues).toEqual([{ start: 61, end: 63, text: 'Hello\n' }]);
    expect(parseWebVtt('WEBVTT\n\n00:00:03.000 --> 00:00:01.000\nInvalid')).toEqual([]);
    expect(parseWebVtt('WEBVTT\n\n-00:00:01.000 --> 00:00:01.000\nA &amp; B', 60)).toEqual([{ start: 59, end: 61, text: 'A & B' }]);
  });
});
