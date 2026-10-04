import { PlayerOperationError } from './types';

/** Typed fetch failures must not hide permanent refusals from the demuxer's retry policy. */
export function sessionMediaRetryDelay(direct: boolean): (attempts: number, error: unknown) => number | null {
  return (attempts, error) => {
    if (error instanceof PlayerOperationError && (
      ['authorization-failed', 'authorization-unsupported', 'expired-source', 'unsupported-format'].includes(error.code)
      || (direct && error.code === 'connection-failed')
    )) return null;
    return Math.min(2 ** (attempts - 2), 16);
  };
}

interface TransferSample { readonly bytes: number; readonly seconds: number; }
/** The application supplies an authorized delivery, not an arbitrary proxy URL. */
export function checkedMediaDelivery(value: string): URL {
  let url: URL;
  try { url = new URL(value, location.href); }
  catch { throw new PlayerOperationError('authorization-unsupported', 'Invalid media delivery.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash
    || (location.protocol === 'https:' && url.protocol !== 'https:' && !('__TAURI_INTERNALS__' in window)))
    throw new PlayerOperationError('authorization-unsupported', 'This media delivery requires a secure gateway.');
  return url;
}

/** One delivery-origin/directory fence for files, manifests, segments and keys. */
export function sessionMediaRequest(url: string, input: RequestInfo | URL, init?: RequestInit): Request {
  const delivery = checkedMediaDelivery(url);
  const prefix = delivery.pathname.slice(0, delivery.pathname.lastIndexOf('/') + 1);
  const inherited = typeof input === 'string' || input instanceof URL ? undefined : input;
  const target = checkedMediaDelivery(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, delivery).href);
  if (target.origin !== delivery.origin || !target.pathname.startsWith(prefix)
    || /%(?:2f|5c|25)/i.test(target.pathname))
    throw new PlayerOperationError('authorization-unsupported', 'The playlist contains a resource outside its playback session.');
  const method = (init?.method ?? inherited?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD')
    throw new PlayerOperationError('authorization-unsupported', 'Media requests must be read-only.');
  // Media capabilities carry their own authority. Never forward a backend
  // bearer, cookies, an upstream credential, or a referring page URL.
  const supplied = new Headers(init?.headers ?? inherited?.headers);
  const headers = new Headers();
  for (const name of ['range', 'if-range', 'accept']) {
    const value = supplied.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Request(target.href, { method, headers, signal: init?.signal ?? inherited?.signal,
    credentials: 'omit', redirect: 'error', mode: 'cors', referrerPolicy: 'no-referrer' });
}

const TS_PACKET = 188, TS_SYNC = 0x47, TS_RUN = 5, SNIFF_LIMIT = 64 * 1024;
const MEDIA_BOXES = new Set(['ftyp', 'styp', 'moof', 'moov', 'sidx', 'emsg', 'prft']);

/**
 * Offset of the first MPEG-TS packet in `bytes`, or -1. IPTV CDNs disguise
 * segments as images or fonts by prepending a real PNG/JPEG/GIF header (or
 * other junk) to the transport stream, so a segment is classified by its
 * bytes, never by its name or Content-Type. A packet run must repeat at the
 * 188-byte stride; a short buffer that ends the run still needs three packets.
 */
export function transportStreamOffset(bytes: Uint8Array): number {
  const scan = Math.min(bytes.length, SNIFF_LIMIT);
  for (let at = 0; at < scan; at++) {
    if (bytes[at] !== TS_SYNC) continue;
    let packets = 0;
    for (let i = at; i < bytes.length && bytes[i] === TS_SYNC && packets < TS_RUN; i += TS_PACKET) packets++;
    if (packets === TS_RUN || (packets >= 3 && at + packets * TS_PACKET >= bytes.length)) return at;
  }
  return -1;
}

/** Leading bytes that already identify a real segment format stay untouched. */
function recognizedSegmentStart(head: Uint8Array): boolean {
  // 0x47 alone is also 'G' of a GIF disguise; a TS start repeats at the stride.
  if (head[0] === TS_SYNC && head[TS_PACKET] === TS_SYNC) return true;
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return true; // ID3-timestamped packed audio
  return head.length >= 8 && MEDIA_BOXES.has(String.fromCharCode(...head.subarray(4, 8)));
}

/** Reads a bounded head and drops a disguise prefix before the first TS packet. */
async function undisguisedBody(body: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<{ body: ReadableStream<Uint8Array<ArrayBuffer>>; offset: number }> {
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0, done = false;
  while (!done && length < SNIFF_LIMIT) {
    const next = await reader.read();
    if (next.done) done = true;
    else { chunks.push(next.value); length += next.value.length; }
    if (chunks.length && recognizedSegmentStart(chunks[0]!)) break;
  }
  const head = new Uint8Array(length);
  chunks.reduce((at, chunk) => { head.set(chunk, at); return at + chunk.length; }, 0);
  const found = recognizedSegmentStart(head) ? 0 : transportStreamOffset(head);
  const offset = Math.max(0, found);
  let pending: Uint8Array<ArrayBuffer> | null = head.subarray(offset);
  return { offset, body: new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      if (pending) { const first = pending; pending = null; if (first.length) { controller.enqueue(first); return; } }
      if (done) { controller.close(); return; }
      try {
        const next = await reader.read();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      } catch (cause) { controller.error(cause); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }) };
}

/** Byte positions after the disguise prefix map back to the stripped segment. */
function strippedHeaders(headers: Headers, offset: number): Headers {
  const next = new Headers(headers);
  const length = Number(headers.get('content-length'));
  if (headers.has('content-length') && Number.isFinite(length)) next.set('content-length', String(Math.max(0, length - offset)));
  const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(headers.get('content-range') ?? '');
  if (range) next.set('content-range', `bytes ${Math.max(0, Number(range[1]) - offset)}-${Number(range[2]) - offset}/${range[3] === '*' ? '*' : Number(range[3]) - offset}`);
  return next;
}

/** Nested resources stay inside the selected delivery even on another gateway. */
export function sessionMediaFetch(url: string, observe?: (sample: TransferSample) => void): typeof fetch {
  const delivery = checkedMediaDelivery(url);
  // Segment URL -> bytes of disguise prefix removed from its first response;
  // later byte ranges of the same segment are shifted past that prefix.
  const disguised = new Map<string, number>();
  let hls = delivery.pathname.endsWith('.m3u8');
  return async (input, init) => {
    const request = sessionMediaRequest(url, input, init);
    const target = new URL(request.url);
    const shift = disguised.get(target.href) ?? 0;
    const requested = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') ?? '');
    if (shift && requested)
      request.headers.set('range', `bytes=${Number(requested[1]) + shift}-${requested[2] ? Number(requested[2]) + shift : ''}`);
    const options = { method: request.method, headers: request.headers, signal: request.signal,
      credentials: request.credentials, redirect: request.redirect, referrerPolicy: request.referrerPolicy, mode: request.mode };
    let response: Response;
    try {
      response = '__TAURI_INTERNALS__' in window
        ? await (await import('@tauri-apps/plugin-http')).fetch(target.href, { ...options, maxRedirections: 0 })
        : await fetch(target.href, options);
    } catch (cause) {
      if (request.signal.aborted) throw cause;
      throw new PlayerOperationError('connection-failed', 'Media connection failed.', undefined, 'network');
    }
    if (response.status === 401 || response.status === 403)
      throw new PlayerOperationError('authorization-failed', 'Media authorization was refused.', undefined, 'authorization');
    if (response.status === 410)
      throw new PlayerOperationError('expired-source', 'Media authorization expired.', undefined, 'authorization');
    if (response.status === 406)
      throw new PlayerOperationError('unsupported-format', 'This media needs a compatible delivery format.', undefined, 'container');
    if (!response.ok && response.status !== 416)
      throw new PlayerOperationError('connection-failed', 'Media could not be read. Retry playback.', undefined, 'network');
    const playlist = target.pathname.endsWith('.m3u8') || !!response.headers.get('content-type')?.includes('mpegurl');
    if (playlist) hls = true;
    if (playlist || !response.body || response.status === 416 || request.method !== 'GET') return response;
    let body = response.body, headers = response.headers;
    if (hls && (response.status === 200 || /^bytes 0-/.test(response.headers.get('content-range') ?? ''))) {
      // The body starts at the segment's first byte: classify it by content.
      const sniffed = await undisguisedBody(body);
      body = sniffed.body;
      if (sniffed.offset) { disguised.set(target.href, sniffed.offset); headers = strippedHeaders(headers, sniffed.offset); }
    } else if (shift) headers = strippedHeaders(headers, shift);
    if (!observe) return body === response.body && headers === response.headers ? response : new Response(body, { status: response.status, statusText: response.statusText, headers });
    const reader = body.getReader();
    let start = 0, bytes = 0;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!start) start = performance.now();
        try {
          const next = await reader.read();
          if (next.done) { if (bytes) observe({ bytes, seconds: Math.max(0.001, (performance.now() - start) / 1000) }); controller.close(); }
          else { bytes += next.value.length; controller.enqueue(next.value); }
        } catch { controller.error(new PlayerOperationError('connection-failed', 'Media body was interrupted.', undefined, 'network')); }
      },
      cancel(reason) { return reader.cancel(reason); },
    }), { status: response.status, statusText: response.statusText, headers });
  };
}
