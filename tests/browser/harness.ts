import { configureBrowserPlayback, createPlayer, deliveryCapabilitiesFor, PlaybackSessionController, type Player, type PlayerSnapshot, type PlaybackCapabilities } from '../../src/index';
import { MediabunnyAdapter } from '../../src/mediabunny';
import { MediabunnyMseAdapter } from '../../src/mediabunny-mse';
import { VizioHtml5Adapter } from '../../src/vizio-html5';

const video = document.querySelector('video')!, canvas = document.querySelector('canvas')!, report = document.querySelector('pre')!;
configureBrowserPlayback({ clientInspection: true, localRemux: true });
let player: Player | undefined;
let serverController: PlaybackSessionController | undefined;
let snapshot: PlayerSnapshot | undefined;
let unsubscribe: (() => void) | undefined;
const events: Array<{ at: number; state: string; position: number }> = [];
const started = performance.now();
let lastState = '';
let presentedTime: number | undefined;
let reliableFrameClock = false;
if (video.requestVideoFrameCallback) {
  const frame = (_: number, metadata: VideoFrameCallbackMetadata) => { if (presentedTime !== undefined && metadata.mediaTime > presentedTime + 0.001) reliableFrameClock = true; presentedTime = metadata.mediaTime; video.requestVideoFrameCallback(frame); };
  video.requestVideoFrameCallback(frame);
}
const api = {
  get snapshot() { return snapshot; }, get events() { return events; },
  async open(file = 'h264-aac.mkv', engine = 'mse', position = 0, kind: 'vod' | 'live' = 'vod') {
    await serverController?.stop(); serverController = undefined;
    reliableFrameClock = false; presentedTime = undefined;
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
  async text(id?: string | null) { await player!.loadTextTracks?.(); if (id !== undefined) await player!.selectTextTrack(id); return snapshot?.tracks; },
  async quality(id: string) { await player!.selectQuality?.(id); },
  presentation() { return snapshot?.diagnostics?.engine === 'mediabunny' ? snapshot.diagnostics.presentedPositionSeconds
    : !reliableFrameClock || presentedTime === undefined ? undefined : presentedTime + (snapshot?.time.positionSeconds ?? 0) - video.currentTime; },
  async pause() { await player!.pause(); }, async play() { await player!.play(); }, async stop() { await player!.stop(); },
  async dispose() { await serverController?.stop(); serverController = undefined; await player?.dispose(); unsubscribe?.(); },
};
const snake = (value: unknown): unknown => Array.isArray(value) ? value.map(snake) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), snake(item)])) : value;
Object.assign(api, { async server(fixture: string) {
  await serverController?.stop();
  unsubscribe?.(); await player?.dispose();
  player = createPlayer({platform:'html5',video,canvas}); await player.setMuted?.(true);
  const sessions: Array<{mode: string; videoMode: string; audioMode: string}> = [];
  let capabilities: PlaybackCapabilities = await deliveryCapabilitiesFor('html5')();
  const controller = new PlaybackSessionController({player,capabilities,backend:{
    async startPlayback(request) {
      capabilities = { ...request.capabilities, directPlay: !request.managedOnly };
      const response = await fetch('/engine/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fixture,position:request.position ?? 0,capabilities:snake(capabilities),force:request.forceTranscode ?? false})});
      if(!response.ok)throw Object.assign(new Error('Fixture preparation failed'),{status:response.status});
      const raw=await response.json();
      const value={id:raw.id,url:new URL(raw.url,location.href).href,headers:{},format:raw.format,mode:raw.mode,videoMode:raw.video_mode,audioMode:raw.audio_mode,position:raw.position,live:raw.live,duration:raw.duration,audioTracks:[],subtitleTracks:[],subtitlesSupported:false};
      sessions.push({mode:value.mode,videoMode:value.videoMode,audioMode:value.audioMode});return value;
    }, async stopPlayback(id) { await fetch(`/engine/session/${id}`,{method:'DELETE'}); },
  }});
  serverController = controller;
  unsubscribe=player.subscribe(value=>{snapshot=value;void controller.recoverPlayback(value).catch(()=>{});});
  await controller.start({item:{id:fixture,type:'movie'},source:{id:fixture}});
  return {sessions,snapshot};
} });
Object.assign(window, { mediaTest: api });
const params = new URLSearchParams(location.search);
if (params.has('run')) void (async () => {
  const results: unknown[] = [];
  const post = async (stage: string) => { await fetch('/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage, userAgent: navigator.userAgent, secure: isSecureContext, results, snapshot, events }) }); };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const files = params.has('hd') ? ['h264-1080p30.mkv', 'h264-1080p60.mkv', 'hevc-4k-main.mkv', 'hevc-4k-main10.mkv']
      : ['h264-aac.mkv', 'hevc-main.mkv', 'hevc-main10.mkv', 'h264-1080p60.mkv', 'long-gop.mkv'];
    for (const file of files) {
      const begin = performance.now(); await api.open(file, 'mse'); await sleep(2500);
      const initial = snapshot?.time.positionSeconds;
      const seekTarget = params.has('hd') ? 1.5 : 7;
      await api.pause(); await api.seek(seekTarget); await sleep(150);
      const presented = api.presentation();
      if (presented !== undefined && Math.abs(presented - seekTarget) > 0.08) throw new Error(`Incorrect presented seek frame: ${presented}`);
      await api.play(); await sleep(1500);
      const quality = video.getVideoPlaybackQuality();
      results.push({ file, preparedMs: performance.now() - begin - 4150, initial, seekTarget, presented, frameTiming: snapshot?.diagnostics?.frameTiming, afterSeek: snapshot?.time.positionSeconds, state: snapshot?.state, frames: quality.totalVideoFrames, dropped: quality.droppedVideoFrames });
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
