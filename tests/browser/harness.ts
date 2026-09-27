import { configureBrowserPlayback, createPlayer, type Player, type PlayerSnapshot } from '../../src/index';
import { MediabunnyAdapter } from '../../src/mediabunny';
import { MediabunnyMseAdapter } from '../../src/mediabunny-mse';
import { VizioHtml5Adapter } from '../../src/vizio-html5';

const video = document.querySelector('video')!, canvas = document.querySelector('canvas')!, report = document.querySelector('pre')!;
configureBrowserPlayback({ clientInspection: true, localRemux: true });
let player: Player | undefined;
let snapshot: PlayerSnapshot | undefined;
let unsubscribe: (() => void) | undefined;
const events: Array<{ at: number; state: string; position: number }> = [];
const started = performance.now();
let lastState = '';
const api = {
  get snapshot() { return snapshot; }, get events() { return events; },
  async open(file = 'h264-aac.mkv', engine = 'mse', position = 0, kind: 'vod' | 'live' = 'vod') {
    unsubscribe?.(); await player?.dispose();
    video.style.visibility = engine === 'bunny' ? 'hidden' : ''; canvas.style.display = engine === 'bunny' || engine === 'auto' ? '' : 'none';
    player = engine === 'mse' ? new MediabunnyMseAdapter(video) : engine === 'bunny' ? new MediabunnyAdapter(canvas)
      : engine === 'native' ? new VizioHtml5Adapter(video) : createPlayer({ platform: 'html5', video, canvas });
    await player.setMuted?.(true);
    unsubscribe = player.subscribe(value => {
      snapshot = value;
      if (value.state !== lastState) { events.push({ at: performance.now() - started, state: value.state, position: value.time.positionSeconds }); lastState = value.state; }
      report.textContent = JSON.stringify({ userAgent: navigator.userAgent, elapsed: Math.round((performance.now() - started) / 1000), snapshot }, null, 2);
    });
    await player.open({ url: new URL(`/media/fixtures/cap/${file}`, location.href).href, kind, deliveryFormat: file.includes('.m3u8') ? 'hls' : undefined, deliveryMode: 'direct', startAtSeconds: position, adoptEngineDuration: true });
    return snapshot;
  },
  async seek(position: number) { await player!.seek(position); },
  async audio(id: string) { await player!.selectAudioTrack(id); },
  async quality(id: string) { await player!.selectQuality?.(id); },
  async pause() { await player!.pause(); }, async play() { await player!.play(); }, async stop() { await player!.stop(); },
  async dispose() { await player?.dispose(); unsubscribe?.(); },
};
Object.assign(window, { mediaTest: api });
const params = new URLSearchParams(location.search);
if (params.has('run')) void (async () => {
  const results: unknown[] = [];
  const post = async (stage: string) => { await fetch('/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage, userAgent: navigator.userAgent, secure: isSecureContext, results, snapshot, events }) }); };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  try {
    for (const file of ['h264-aac.mkv', 'hevc-main.mkv', 'hevc-main10.mkv', 'h264-1080p60.mkv', 'long-gop.mkv']) {
      const begin = performance.now(); await api.open(file, 'mse'); await sleep(2500);
      const initial = snapshot?.time.positionSeconds; await api.seek(7); await sleep(1500);
      const quality = video.getVideoPlaybackQuality();
      results.push({ file, preparedMs: performance.now() - begin - 4000, initial, afterSeek: snapshot?.time.positionSeconds, state: snapshot?.state, frames: quality.totalVideoFrames, dropped: quality.droppedVideoFrames });
      await post('fixture');
    }
    if (params.has('soak')) {
      await api.open('soak.mkv', 'mse');
      const deadline = performance.now() + 30 * 60 * 1000;
      while (performance.now() < deadline) { await sleep(15000); await post('soak'); if (snapshot?.state === 'error') throw new Error('Soak playback failed'); }
    }
    await post('complete');
  } catch (cause) { results.push({ error: String(cause) }); await post('failed'); }
})();
