import { PlayerOperationError } from './types';

export interface TransferSample { readonly bytes: number; readonly seconds: number; }
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

/** Nested resources stay inside the selected delivery even on another gateway. */
export function sessionMediaFetch(url: string, observe?: (sample: TransferSample) => void): typeof fetch {
  checkedMediaDelivery(url);
  return async (input, init) => {
    const request = sessionMediaRequest(url, input, init);
    const target = new URL(request.url);
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
    if (!observe || !response.body || target.pathname.endsWith('.m3u8') || response.headers.get('content-type')?.includes('mpegurl')) return response;
    const reader = response.body.getReader();
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
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
