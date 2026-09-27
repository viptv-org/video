import { createServer } from 'vite';
import { createReadStream, statSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const fixtures = resolve(process.env.MEDIA_FIXTURES || '/tmp/viptv-media-fixtures');
const resultFile = process.env.MEDIA_RESULTS || '/tmp/viptv-media-results.json';
const https = process.env.MEDIA_TLS_CERT ? { cert: readFileSync(process.env.MEDIA_TLS_CERT), key: readFileSync(process.env.MEDIA_TLS_KEY) } : undefined;
const liveStarts = new Map();
const server = await createServer({ root: process.cwd(), configFile: false, server: { host: '0.0.0.0', port: Number(process.env.MEDIA_PORT || 18789), strictPort: true, allowedHosts: true, https },
  plugins: [{ name: 'real-media-fixtures', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/engine/') || req.url?.startsWith('/media/') && !req.url.startsWith('/media/fixtures/cap/')) {
        const clean = headers => Object.fromEntries(Object.entries(headers).filter(([key]) => !key.startsWith(':') && !['connection','keep-alive','transfer-encoding','upgrade'].includes(key)));
        const proxy = http.request({ hostname: '127.0.0.1', port: 18182, path: req.url, method: req.method, headers: clean(req.headers) }, response => { res.writeHead(response.statusCode, clean(response.headers)); response.pipe(res); });
        proxy.on('error', () => { res.statusCode = 502; res.end('Fixture engine unavailable'); }); req.pipe(proxy); res.on('close',()=>proxy.destroy()); return;
      }
      if (req.url?.startsWith('/qualification/')) {
        const name = basename(new URL(req.url, 'http://localhost').pathname);
        const file = resolve(process.env.MEDIA_HARNESS || '/tmp/viptv-browser-harness', name);
        try { const body = readFileSync(file); res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html' : name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'Content-Length': body.length }); res.end(body); } catch { res.statusCode = 404; res.end(); } return;
      }
      if (req.url?.startsWith('/results') && req.method === 'POST') { let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); }); req.on('end', () => { const value = JSON.parse(body); writeFileSync(resultFile, JSON.stringify(value, null, 2)); console.log('TV_RESULT', JSON.stringify({ stage: value.stage, results: value.results, time: value.snapshot?.time, state: value.snapshot?.state })); res.end('ok'); }); return; }
      if (!req.url?.startsWith('/media/fixtures/cap/')) return next();
      if (/\/continuous(?:-ac3)?\.ts/.test(req.url)) {
        res.writeHead(200, {'Content-Type':'video/mp2t','Cache-Control':'no-store'});
        if (req.method === 'HEAD') { res.end(); return; }
        const ffmpeg = spawn('ffmpeg', ['-v','error','-re','-stream_loop','-1','-i',resolve(fixtures,req.url.includes('-ac3')?'h264-ac3.mkv':'h264-aac.mkv'),'-c','copy','-f','mpegts','pipe:1'], {stdio:['ignore','pipe','ignore']});
        ffmpeg.stdout.pipe(res); res.on('close',()=>ffmpeg.kill()); ffmpeg.on('error',()=>res.destroy()); return;
      }
      if (req.url.includes('/live.m3u8')) {
        const key = req.url;
        if (!liveStarts.has(key)) liveStarts.set(key, Date.now());
        const first = Math.min(24, Math.floor((Date.now() - liveStarts.get(key)) / 2000));
        const body = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n` + Array.from({length:6},(_,i)=>`#EXTINF:2,\nlive/segment-${String(first+i).padStart(3,'0')}.ts\n`).join('');
        res.writeHead(200, {'Content-Type':'application/vnd.apple.mpegurl','Cache-Control':'no-store'});res.end(body);return;
      }
      const name = basename(new URL(req.url, 'http://localhost').pathname);
      let file, size; try { file = resolve(fixtures, req.url.includes('/live/') ? 'live' : req.url.includes('/small/') ? 'small' : '.', name); size = statSync(file).size; } catch { res.statusCode = 404; res.end(); return; }
      const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/); let start = 0, end = size - 1;
      if (range) { start = Number(range[1]); end = Math.min(end, range[2] ? Number(range[2]) : end); if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; } }
      res.writeHead(range ? 206 : 200, { 'Content-Type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : name.endsWith('.ts') ? 'video/mp2t' : name.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(file, { start, end }); stream.pipe(res); res.on('close', () => stream.destroy());
    });
  } }], build: { target: 'chrome87' } });
await server.listen(); console.log('MEDIA_HARNESS', server.resolvedUrls);
