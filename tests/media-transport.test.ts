import { afterEach, expect, it, vi } from 'vitest';
import { sessionMediaFetch } from '../src/mediabunny';
const native = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: native.fetch }));
afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); vi.clearAllMocks(); });
it('keeps every byte-range/segment request scoped to the selected opaque session', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('segment')); vi.stubGlobal('fetch', fetch);
  const delivery = `${location.origin}/media/session/cap/index.m3u8`;
  const request = sessionMediaFetch(delivery);
  await request(`${location.origin}/media/session/cap/seg.ts`, { headers: { Range: 'bytes=0-1023' } });
  expect(fetch).toHaveBeenCalledWith(`${location.origin}/media/session/cap/seg.ts`, expect.objectContaining({ redirect: 'error', headers: { Range: 'bytes=0-1023' } }));
  await expect(request('https://provider.invalid/seg.ts')).rejects.toMatchObject({ code: 'authorization-unsupported' });
  await expect(request(`${location.origin}/media/other/cap/seg.ts`)).rejects.toMatchObject({ code: 'authorization-unsupported' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('uses Tauri native HTTP for MediaBunny resources without bypassing session scope', async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); native.fetch.mockResolvedValue(new Response('segment'));
  const url = `${location.origin}/media/session/cap/movie.mp4`;
  await sessionMediaFetch(url)(url, { headers: { Range: 'bytes=0-255' } });
  expect(native.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ maxRedirections: 0, redirect: 'error' }));
  expect(fetch).not.toHaveBeenCalled();
});
