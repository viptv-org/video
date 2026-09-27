import { PlayerOperationError } from './types';

export interface TransferSample { readonly bytes: number; readonly seconds: number; }
/** Same-origin capabilities, including nested playlists, retain one fetch fence. */
export function sessionMediaFetch(url: string, observe?: (sample: TransferSample) => void): typeof fetch {
  const delivery = new URL(url, location.href);
  const prefix = delivery.pathname.slice(0, delivery.pathname.lastIndexOf('/') + 1);
  return async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, delivery);
    if (target.origin !== delivery.origin || !target.pathname.startsWith(prefix) || !target.pathname.startsWith('/media/'))
      throw new PlayerOperationError('authorization-unsupported', 'The playlist contains a resource outside its playback session.');
    let response: Response;
    try {
      response = '__TAURI_INTERNALS__' in window
        ? await (await import('@tauri-apps/plugin-http')).fetch(target.href, { ...init, redirect: 'error', maxRedirections: 0 })
        : await fetch(target.href, { ...init, redirect: 'error' });
    } catch (cause) {
      if (init?.signal?.aborted) throw cause;
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
