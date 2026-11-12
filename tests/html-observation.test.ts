import { afterEach, describe, expect, it, vi } from 'vitest';
import { VizioHtml5Adapter, type HtmlMediaLike } from '../src/vizio-html5';

class Media implements HtmlMediaLike {
  src = ''; currentTime = 0; duration = 120; paused = true; ended = false; error = null;
  videoWidth = 1920; videoHeight = 1080; readyState = 4; frames = 0; dropped = 0;
  events = new EventTarget();
  play = vi.fn(async () => { this.paused = false; this.emit('playing'); });
  pause = vi.fn(() => { this.paused = true; this.emit('pause'); });
  load = vi.fn();
  removeAttribute = vi.fn(() => { this.src = ''; });
  getVideoPlaybackQuality = () => ({ totalVideoFrames: this.frames, droppedVideoFrames: this.dropped });
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
  it('does not accept predecode dropped frames as the first displayed video frame', async () => {
    vi.useFakeTimers();const media=new Media();media.frames=3;media.dropped=3;
    const player=new VizioHtml5Adapter(media);players.push(player);
    const opening=player.open({url,kind:'vod',startupBudgetMs:500});media.emit('loadedmetadata');await opening;
    await vi.advanceTimersByTimeAsync(501);
    expect(player.snapshot.error?.message).toContain('did not produce a decoded video frame');
    expect(player.snapshot.diagnostics).toMatchObject({videoFrames:3,droppedFrames:3});
  });
  it('reports video-frame stalls separately from advancing audio/media time and resets on a manual seek', async () => {
    vi.useFakeTimers(); const media=new Media();media.frames=1;
    const {player}=await open(media, {unreliableFrameReporting:true});
    media.currentTime=.25;media.frames=2;await vi.advanceTimersByTimeAsync(250);
    media.currentTime=.5;media.frames=3;await vi.advanceTimersByTimeAsync(250);
    expect(player.snapshot.diagnostics?.videoFrameProgress).toBe('advancing');
    media.currentTime=3;await vi.advanceTimersByTimeAsync(2500);
    expect(player.snapshot.diagnostics).toMatchObject({videoFrames:3,mediaPositionSeconds:3,videoFrameProgress:'stalled'});
    expect(player.snapshot.diagnostics?.presentedPositionSeconds).toBeUndefined();
    expect(player.snapshot.state).toBe('playing');expect(media.load).toHaveBeenCalledOnce();
    await player.seek(40);media.frames=4;media.currentTime=40.25;await vi.advanceTimersByTimeAsync(250);
    expect(player.snapshot.diagnostics?.videoFrameProgress).toBe('observing');
    media.frames=5;media.currentTime=40.5;await vi.advanceTimersByTimeAsync(250);
    expect(player.snapshot.diagnostics?.videoFrameProgress).toBe('advancing');
  });
  it('leaves video progress unavailable when an advancing native clock exposes no frame evidence', async () => {
    vi.useFakeTimers();const {media,player}=await open(new Media(),{unreliableFrameReporting:true});
    for(let tick=1;tick<=20;tick++){media.currentTime=tick/4;await vi.advanceTimersByTimeAsync(250);}
    expect(player.snapshot.diagnostics).toMatchObject({mediaPositionSeconds:5,videoFrames:0,videoFrameProgress:'unavailable'});
    expect(player.snapshot.diagnostics?.presentedFrames).toBeUndefined();
  });
  it('fences actual frame callbacks across source replacement and Stop', async () => {
    vi.useFakeTimers();const media=new Media();
    const callbacks: Array<(now:number,metadata:{mediaTime:number;presentedFrames:number})=>void>=[];
    const request=vi.fn((callback:(typeof callbacks)[number])=>{callbacks.push(callback);return callbacks.length;});
    const cancel=vi.fn();Object.assign(media,{requestVideoFrameCallback:request,cancelVideoFrameCallback:cancel});
    const {player}=await open(media,{unreliableFrameReporting:true});
    callbacks[0](0,{mediaTime:.5,presentedFrames:3});media.currentTime=.5;media.emit('timeupdate');
    expect(player.snapshot.diagnostics).toMatchObject({presentedFrames:3,presentedPositionSeconds:.5});
    const stale=callbacks[1];
    const next=player.open({url,kind:'vod',timelineOffsetSeconds:100});media.emit('loadedmetadata');await next;
    stale(0,{mediaTime:50,presentedFrames:999});media.emit('timeupdate');
    expect(player.snapshot.diagnostics?.presentedFrames).toBeUndefined();
    callbacks[2](0,{mediaTime:.25,presentedFrames:1});media.currentTime=.25;media.emit('timeupdate');
    expect(player.snapshot.diagnostics).toMatchObject({presentedFrames:1,presentedPositionSeconds:100.25});
    await player.stop();const count=request.mock.calls.length;callbacks[3](0,{mediaTime:60,presentedFrames:1000});
    expect(request).toHaveBeenCalledTimes(count);expect(cancel).toHaveBeenCalled();
    expect(player.snapshot.state).toBe('stopped');expect(vi.getTimerCount()).toBe(0);
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
