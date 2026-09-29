// Real network/decoder qualification using synthetic media and trusted local TLS.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(new URL('../../../tv-web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const entry = process.env.MEDIA_TEST_URL ?? 'https://viptv.local.test:18789/tests/browser/index.html';
const origin = new URL(entry).origin;
const fixtures = process.env.MEDIA_FIXTURES;
assert(fixtures, 'Set MEDIA_FIXTURES to synthetic HLS fixture directory');
const requests = [];
const server = createServer({ cert: readFileSync('../.local-https/certs/watch.local.test.crt'), key: readFileSync('../.local-https/certs/watch.local.test.key') }, (req, res) => {
  requests.push({ path: req.url, headers: req.headers });
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'range, if-range, accept');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/base/media/viewer/cap/redirect') { res.writeHead(302, { Location: '/escaped' }); res.end(); return; }
  if (req.url === '/base/media/viewer/cap/check') { res.end('safe'); return; }
  const name = req.url?.match(/^\/base\/media\/viewer\/cap\/(index\.m3u8|variant\.m3u8|segment\d+\.ts)$/)?.[1];
  if (!name) { res.writeHead(404); res.end(); return; }
  if (name === 'index.m3u8') { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.42c01e,mp4a.40.2"\nvariant.m3u8\n'); return; }
  try { res.setHeader('Content-Type', name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t'); res.end(readFileSync(resolve(fixtures, name))); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const gateway = `https://watch.local.test:${server.address().port}/base/media/viewer/cap/`;
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.context().addCookies([{ name: 'backend', value: 'fixture-only', url: origin }, { name: 'gateway', value: 'fixture-only', url: gateway }]);
  await page.route('**/*', route => [origin, new URL(gateway).origin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  await page.goto(entry);
  const fence = await page.evaluate(async gateway => {
    const { sessionMediaFetch } = await import('/src/session-media-fetch.ts');
    const scoped = sessionMediaFetch(gateway + 'index.m3u8');
    await scoped(gateway + 'check', { credentials: 'include', headers: { Authorization: 'Bearer fixture-only', Range: 'bytes=0-3' } });
    try { await scoped(gateway + 'redirect'); return false; }
    catch (error) { return error.code === 'connection-failed'; }
  }, gateway);
  assert(fence, 'Redirect must fail closed');
  await page.evaluate(async gateway => {
    const { VizioHtml5Adapter } = await import('/src/vizio-html5.ts');
    const media = document.querySelector('video');
    // Exercise actual hls.js FetchLoader rather than a browser-native HLS hint.
    media.canPlayType = () => '';
    media.muted = true;
    const player = new VizioHtml5Adapter(media);
    window.gatewayPlayer = player;
    await player.open({ url: gateway + 'index.m3u8', kind: 'vod', deliveryMode: 'managed', timelineDurationSeconds: 6 });
    await player.play();
  }, gateway);
  await page.waitForFunction(() => document.querySelector('video').currentTime > 1 && document.querySelector('video').videoWidth > 0, undefined, { timeout: 20000 });
  const observed = await page.evaluate(() => ({ time: document.querySelector('video').currentTime, width: document.querySelector('video').videoWidth, engine: window.gatewayPlayer.snapshot.diagnostics.engine }));
  assert.equal(observed.engine, 'hls.js');
  assert(requests.some(r => r.path.endsWith('/variant.m3u8')));
  assert(requests.some(r => /segment\d+\.ts$/.test(r.path)));
  assert(!requests.some(r => r.path === '/escaped'));
  assert(requests.every(r => !r.headers.authorization && !r.headers.cookie && !r.headers.referer));
  assert.equal(requests.find(r => r.path.endsWith('/check')).headers.range, 'bytes=0-3');
  await page.evaluate(() => window.gatewayPlayer.dispose());
  console.log(JSON.stringify({ passed: true, ...observed, requests: requests.length, credentialFree: true, redirectBlocked: true }));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
