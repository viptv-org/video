import { afterEach, describe, expect, it, vi } from 'vitest';
import { VizioHtml5Adapter, type HtmlMediaLike } from '../src/vizio-html5';

class Media implements HtmlMediaLike {
  src = ''; currentTime = 0; duration = 120; paused = true; ended = false; error = null;
  videoWidth = 1920; videoHeight = 1080; readyState = 4; frames = 0;
  events = new EventTarget();
  play = vi.fn(async () => { this.paused = false; this.emit('playing'); });
  pause = vi.fn(() => { this.paused = true; this.emit('pause'); });
  load = vi.fn();
  removeAttribute = vi.fn(() => { this.src = ''; });
  getVideoPlaybackQuality = () => ({ totalVideoFrames: this.frames });
  addEventListener(event: string, listener: () => void) { this.events.addEventListener(event, listener); }
  removeEventListener(event: string, listener: () => void) { this.events.removeEventListener(event, listener); }
  emit(event: string) { this.events.dispatchEvent(new Event(event)); }
}
const url = `${window.location.origin}/media/session/cap/source.mp4`;
const players: VizioHtml5Adapter[] = [];
afterEach(async () => { for (const player of players.splice(0)) await player.dispose();vi.useRealTimers(); });
async function open(media = new Media(), options = {}) {
  const player = new VizioHtml5Adapter(media, options); players.push(player);
  const opening = player.open({url,kind:'vod'}); media.emit('loadedmetadata'); await opening;
  return {media,player};
}

describe('HTML media observations', () => {
  it('keeps a sparse-event clock current after startup, pause/resume, seek and replacement', async () => {
    vi.useFakeTimers(); const {media,player} = await open(new Media(), {unreliableFrameReporting:true});
    for (let tick = 1; tick <= 20; tick++) { media.currentTime=tick/4;await vi.advanceTimersByTimeAsync(250); }
    expect(player.snapshot.time.positionSeconds).toBe(5);
    await player.pause();media.currentTime=5.25;await vi.advanceTimersByTimeAsync(1000);
    expect(player.snapshot.state).toBe('paused');
    await player.play();media.currentTime=6;await vi.advanceTimersByTimeAsync(250);
    expect(player.snapshot.time.positionSeconds).toBe(6);
    await player.seek(40);media.currentTime=41;await vi.advanceTimersByTimeAsync(250);
    expect(player.snapshot.time.positionSeconds).toBe(41);
    const replacement=player.open({url,kind:'vod',startAtSeconds:10});media.emit('loadedmetadata');await replacement;
    media.currentTime=11;await vi.advanceTimersByTimeAsync(250);
    expect(player.snapshot.time.positionSeconds).toBe(11);
    await player.stop();await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);expect(player.snapshot.state).toBe('stopped');
  });
  it('does not let a delayed play acknowledgment override a later Pause or restart observation after Stop', async () => {
    vi.useFakeTimers(); const {media,player}=await open();
    let resolve!:()=>void;media.play.mockImplementation(()=>new Promise<void>(done=>{resolve=done;}));
    const playing=player.play();await player.pause();resolve();await playing;
    expect(player.snapshot.state).toBe('paused');expect(media.paused).toBe(true);
    const late=player.play();await player.stop();resolve();await late;
    expect(player.snapshot.state).toBe('stopped');expect(vi.getTimerCount()).toBe(0);
  });
});
