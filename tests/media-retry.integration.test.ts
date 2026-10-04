// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ALL_FORMATS, Input, UrlSource } from 'mediabunny';
import { sessionMediaFetch, sessionMediaRetryDelay } from '../src/session-media-fetch';

beforeEach(() => {
  vi.stubGlobal('location', { href: 'https://watch.example/', protocol: 'https:' });
  vi.stubGlobal('window', { location: { href: 'https://watch.example/', origin: 'https://watch.example' } });
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  { name: 'CORS-style fetch rejection', response: undefined, code: 'connection-failed' },
  { name: 'authorization refusal', response: 403, code: 'authorization-failed' },
  { name: 'expired delivery', response: 410, code: 'expired-source' },
])('settles the real demuxer after one $name rather than waiting for the player timeout', async ({ response, code }) => {
  const fetch = vi.fn();
  if (response) fetch.mockResolvedValue(new Response('', { status: response }));
  else fetch.mockRejectedValue(new TypeError('Failed to fetch'));
  vi.stubGlobal('fetch', fetch);
  const url = 'https://source.example/movie.mp4';
  const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url, {
    fetchFn: sessionMediaFetch(url), getRetryDelay: sessionMediaRetryDelay(true),
  }) });
  try {
    await expect(input.getFormat()).rejects.toMatchObject({ code });
    expect(fetch).toHaveBeenCalledOnce();
  } finally { input.dispose(); }
});

it('retries a transient managed fetch and reads the next successful response', async () => {
  const ftyp = new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
  const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockImplementation(() => new Response(ftyp, { status: 200, headers: { 'Content-Length': '24' } }));
  vi.stubGlobal('fetch', fetch);
  const url = 'https://gateway.example/media/session/source.mp4';
  const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url, {
    fetchFn: sessionMediaFetch(url), getRetryDelay: sessionMediaRetryDelay(false),
  }) });
  try {
    expect(await input.getFormat()).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { input.dispose(); }
});
