// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sessionMediaFetch, sessionMediaRequest } from '../src/session-media-fetch';
const native = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: native.fetch }));
beforeEach(() => { vi.stubGlobal('window', {}); vi.stubGlobal('location', new URL('https://app.example/')); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('keeps every byte-range/segment request scoped to the selected opaque session', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('segment')); vi.stubGlobal('fetch', fetch);
  const delivery = `${location.origin}/media/session/cap/index.m3u8`;
  const request = sessionMediaFetch(delivery);
  await request(`${location.origin}/media/session/cap/seg.ts`, { headers: { Range: 'bytes=0-1023' } });
  expect(fetch).toHaveBeenCalledWith(`${location.origin}/media/session/cap/seg.ts`, expect.objectContaining({ redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' }));
  expect(fetch.mock.calls[0][1].headers.get('range')).toBe('bytes=0-1023');
  await expect(request('https://provider.invalid/seg.ts')).rejects.toMatchObject({ code: 'authorization-unsupported' });
  await expect(request(`${location.origin}/media/other/cap/seg.ts`)).rejects.toMatchObject({ code: 'authorization-unsupported' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('supports a separate HTTPS gateway with a base path without forwarding credentials', async () => {
  const url = 'https://gateway.example/playback/media/viewer/cap/index.m3u8';
  const request = sessionMediaRequest(url, new Request(url, { headers: { Authorization: 'Bearer backend-secret', Cookie: 'session=secret', Range: 'bytes=0-99' }, credentials: 'include' }));
  expect(request.headers.get('range')).toBe('bytes=0-99');
  expect(request.headers.get('authorization')).toBeNull();
  expect(request.headers.get('cookie')).toBeNull();
  expect(request.credentials).toBe('omit');
  expect(request.redirect).toBe('error');
  expect(request.referrerPolicy).toBe('no-referrer');
  expect(sessionMediaRequest(url, 'segment.ts').url).toBe('https://gateway.example/playback/media/viewer/cap/segment.ts');
  for (const target of ['../other/segment.ts', 'https://elsewhere.example/segment.ts', 'https://user:secret@gateway.example/playback/media/viewer/cap/key', '%2f..%2fsecret', '%252e%252e/secret', 'file:///secret']) {
    expect(() => sessionMediaRequest(url, target)).toThrow();
  }
  expect(() => sessionMediaRequest(url, url, { method: 'POST', body: 'secret' })).toThrow();
});

it('preserves cancellation through the scoped request', () => {
  const abort = new AbortController();
  const request = sessionMediaRequest('https://gateway.example/media/cap/file', 'file', { signal: abort.signal });
  abort.abort();
  expect(request.signal.aborted).toBe(true);
});

it('does not relabel an inherited Request cancellation as a connection failure', async () => {
  const controller = new AbortController();
  const url = 'https://gateway.example/media/cap/file';
  const input = new Request(url, { signal: controller.signal });
  controller.abort();
  const cancelled = new DOMException('Cancelled', 'AbortError');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cancelled));
  await expect(sessionMediaFetch(url)(input)).rejects.toBe(cancelled);
});

it('requires HTTPS in a secure browser while retaining native HTTP input support', () => {
  const url = 'http://provider.example/live/source.ts';
  expect(() => sessionMediaRequest(url, url)).toThrow();
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  expect(sessionMediaRequest(url, url).url).toBe(url);
});
it('uses Tauri native HTTP for MediaBunny resources without bypassing session scope', async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); native.fetch.mockResolvedValue(new Response('segment'));
  const url = `${location.origin}/media/session/cap/movie.mp4`;
  await sessionMediaFetch(url)(url, { headers: { Range: 'bytes=0-255' } });
  expect(native.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ maxRedirections: 0, redirect: 'error' }));
  expect(fetch).not.toHaveBeenCalled();
});
