// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sessionMediaFetch, sessionMediaRequest, transportStreamOffset } from '../src/session-media-fetch';
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

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00');
function transportStream(packets: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(packets * 188).fill(0xff);
  for (let i = 0; i < packets; i++) { bytes[i * 188] = 0x47; bytes[i * 188 + 1] = i; }
  return bytes;
}
const join = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); parts.reduce((at, p) => { out.set(p, at); return at + p.length; }, 0); return out; };

it('finds the transport stream behind an image or junk disguise prefix', () => {
  const ts = transportStream(8);
  expect(transportStreamOffset(ts)).toBe(0);
  for (const prefix of [PNG, JPEG, GIF, new TextEncoder().encode('/* css */ body{}')])
    expect(transportStreamOffset(join(prefix, ts))).toBe(prefix.length);
  expect(transportStreamOffset(new Uint8Array(4096).fill(0x47 + 1))).toBe(-1);
  // A lone sync byte is not a packet run.
  expect(transportStreamOffset(join(Uint8Array.of(0x47, 1, 2), new Uint8Array(1000)))).toBe(-1);
});

it('strips a disguise prefix from HLS segments regardless of name and Content-Type', async () => {
  const ts = transportStream(8);
  const segment = join(PNG, ts);
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const range = /bytes=(\d+)-(\d*)/.exec(new Headers(init.headers).get('range') ?? '');
    if (!range) return new Response(segment, { headers: { 'content-type': 'image/png', 'content-length': String(segment.length) } });
    const start = Number(range[1]), end = range[2] ? Number(range[2]) : segment.length - 1;
    return new Response(segment.slice(start, end + 1), { status: 206, headers: { 'content-type': 'image/png', 'content-range': `bytes ${start}-${end}/${segment.length}` } });
  });
  vi.stubGlobal('fetch', fetch);
  const delivery = `${location.origin}/media/session/cap/index.m3u8`;
  const request = sessionMediaFetch(delivery);
  const first = await request(`${location.origin}/media/session/cap/seg0.png`, { headers: { Range: 'bytes=0-' } });
  expect(first.headers.get('content-range')).toBe(`bytes 0-${ts.length - 1}/${ts.length}`);
  expect(new Uint8Array(await first.arrayBuffer())).toEqual(ts);
  // A later range of the same segment addresses the stripped stream.
  const later = await request(`${location.origin}/media/session/cap/seg0.png`, { headers: { Range: 'bytes=188-375' } });
  expect(new Headers(fetch.mock.calls[1]![1].headers).get('range')).toBe(`bytes=${188 + PNG.length}-${375 + PNG.length}`);
  expect(later.headers.get('content-range')).toBe(`bytes 188-375/${ts.length}`);
  expect(new Uint8Array(await later.arrayBuffer())).toEqual(ts.slice(188, 376));
  const whole = await request(`${location.origin}/media/session/cap/seg1`);
  expect(whole.headers.get('content-length')).toBe(String(ts.length));
  expect(new Uint8Array(await whole.arrayBuffer())).toEqual(ts);
});

it('leaves undisguised segments and non-HLS files byte-for-byte intact', async () => {
  const ts = transportStream(8), gif = join(GIF, ts);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.endsWith('.mp4') ? gif : ts)));
  const hls = sessionMediaFetch(`${location.origin}/media/session/cap/index.m3u8`);
  expect(new Uint8Array(await (await hls(`${location.origin}/media/session/cap/seg.ts`)).arrayBuffer())).toEqual(ts);
  const file = `${location.origin}/media/session/cap/movie.mp4`;
  expect(new Uint8Array(await (await sessionMediaFetch(file)(file)).arrayBuffer())).toEqual(gif);
});
