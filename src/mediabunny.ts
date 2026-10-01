import { Input, UrlSource, ALL_FORMATS, CanvasSink, AudioBufferSink, type InputTrack, type InputVideoTrack, type InputAudioTrack, type WrappedCanvas, type WrappedAudioBuffer } from 'mediabunny';
import { SessionPlayer } from './session';
import { hasSourceAuthorization } from './source-authorization';
import { PlayerOperationError, growOnlyDuration, timelineDuration, type OpenPlayerRequest, type PlayerCapabilities } from './types';

import { mediaFailure, canChangeMediaPath } from './browser-policy';
import { audioChoices, chooseAudio, trackId, videoChoices, AdaptiveQuality } from './media-tracks';
import { sessionMediaFetch } from './session-media-fetch';
import { delay } from './primitives';
export { sessionMediaFetch } from './session-media-fetch';
const MEDIABUNNY_CAPABILITIES: PlayerCapabilities = {
  platform: 'html5', engine: 'Mediabunny / WebCodecs', directNative: 'probe-required', adaptiveStreaming: 'probe-required', drm: 'unsupported',
  canPause: true, canSeek: true, canSetVolume: true, canSelectAudioTrack: true, canSelectTextTrack: false, canDisableTextTrack: false,
  canUseCookies: false, canUseUserAgent: false,
  limitations: ['Actual tracks must pass WebCodecs decoding checks.', 'Track replacement is performed through the selected backend session.', 'Encrypted DRM media uses the compatible native fallback when available.'],
};

/** A bounded two-frame / half-second audio pipeline; no full-file buffering or local encoding. */
export class MediabunnyAdapter extends SessionPlayer {
  readonly capabilities = MEDIABUNNY_CAPABILITIES;
  private input?: Input;
  private context?: AudioContext;
  private gain?: GainNode;
  private videoSink?: CanvasSink;
  private videoTrack?: InputVideoTrack;
  private audioSink?: AudioBufferSink;
  private videoIterator?: AsyncGenerator<WrappedCanvas, void, unknown>;
  private audioIterator?: AsyncGenerator<WrappedAudioBuffer, void, unknown>;
  private nodes = new Set<AudioBufferSourceNode>();
  private request?: OpenPlayerRequest;
  private generation = 0;
  private sourceGeneration = 0;
  private running = false;
  private animation?: number;
  private frames: WrappedCanvas[] = [];
  private videoEnd = 0;
  private audioEnd = 0;
  private audioTrack?: InputAudioTrack;
  private scheduled = new Set<WrappedAudioBuffer>();
  private qualityId = 'auto';
  private adaptive = new AdaptiveQuality();
  private switching = false;
  private lastSwitch = 0;
  private videoChoices: Awaited<ReturnType<typeof videoChoices>> = { tracks: [], choices: [] };
  private liveWindow?: { start: number; end: number; target: number };
  private presented = 0;
  private dropped = 0;
  private previewPending = false;
  private openingGeneration = 0;
  private performanceStart = 0;
  private liveStalls = 0;
  private bufferingSince = 0;
  private lastLiveReconnect = 0;
  private rejectedQualities = new Set<string>();
  private playing = false;
  private position = 0;
  private firstTimestamp = 0;
  private duration: number | null = null;
  private observedTitleDuration: number | null = null;
  private anchor = 0;
  private volume = 1;
  private muted = false;
  private ticker?: ReturnType<typeof setInterval>;
  private videoDone = false;
  private audioDone = false;
  private live = false;
  private liveRefresh?: ReturnType<typeof setTimeout>;

  /** Decoded-ahead window end in native seconds, past the live position. */
  private decodedEnd = 0;
  /** Audio packets decoded ahead of the clock, scheduled as the clock drains. */
  private audioQueue: WrappedAudioBuffer[] = [];
  /** True while the audio producer is still filling the queue. */
  /** Bound on queued audio packets: enough readahead to feed the preseek gate. */
  private readonly audioQueueLimit = 120;

  constructor(private readonly canvas: HTMLCanvasElement) { super(); }

  async open(request: OpenPlayerRequest): Promise<void> {
    const opening = ++this.openingGeneration;
    await this.release();
    if (opening !== this.openingGeneration) return;
    const session = this.startSession(request.kind);
    if (this.request?.url !== request.url) { this.liveStalls = 0; this.lastLiveReconnect = 0; }
    this.request = request;
    this.rejectedQualities.clear();
    this.performanceStart = performance.now(); this.presented = 0; this.dropped = 0;
    this.observedTitleDuration = null;
    const openedAt = performance.now();
    const token = ++this.generation;
    const sourceToken = this.sourceGeneration;
    if (hasSourceAuthorization(request.authorization))
      throw new PlayerOperationError('authorization-unsupported', 'Playback requires a backend-compatible media URL.');
    const input = this.input = new Input({
      // Readahead and bounded retries stay the library defaults: disabling
      // retries turned one evicted segment of a rolling playlist into a hard
      // read failure, and a 32 MiB cache still bounds memory per session.
      source: new UrlSource(request.url, { fetchFn: sessionMediaFetch(request.url, s => this.adaptive.sample(s.bytes, s.seconds)), maxCacheSize: 32 * 1024 * 1024 }),
      formats: ALL_FORMATS,
      formatOptions: { hls: { offsetTimestampsByDateTime: false } },
    });
    this.videoChoices = await videoChoices(input);
    this.qualityId = request.qualityId ?? 'auto';
    const video = this.videoChoices.tracks.find(t => trackId('video', t.id) === this.qualityId) ?? await input.getPrimaryVideoTrack();
    if (!this.isCurrent(session) || token !== this.generation) return;
    if (!video || !(await ensureDecodable(video))) throw new PlayerOperationError('unsupported-format', 'Mediabunny cannot decode this video track.', undefined, 'video-codec');
    if (await video.hasHighDynamicRange()) throw new PlayerOperationError('unsupported-format', 'HDR requires a qualified presentation path.', undefined, 'rendering');
    const audio = await chooseAudio(video, request);
    this.audioTrack = audio ?? undefined;
    if (audio && !(await ensureDecodable(audio))) throw new PlayerOperationError('unsupported-format', 'Mediabunny cannot decode this audio track.', undefined, 'audio-codec');
    // The example creates the context at the track's own sample rate; mismatched
    // rates resample and drift against the picture.
    const sampleRate = audio ? await audio.getSampleRate() : undefined;
    if (!this.isCurrent(session) || token !== this.generation) return;
    this.context = new AudioContext(sampleRate ? { sampleRate } : undefined);
    this.gain = this.context.createGain(); this.gain.connect(this.context.destination); this.applyVolume();
    if (!this.isCurrent(session) || token !== this.generation) return;
    const [videoConfig, audioConfig, width, height, start] = await Promise.all([
      video.getDecoderConfig(), audio?.getDecoderConfig(), video.getDisplayWidth(), video.getDisplayHeight(), video.getFirstTimestamp(),
    ]);
    if (!this.isCurrent(session) || token !== this.generation) return;
    this.firstTimestamp = start;
    // Managed output is a rolling playlist until the source ends, so it is a
    // live stream even for a movie: the example reads the window, refreshes its
    // end and never waits for ENDLIST. The session owns the title duration.
    this.live = request.kind === 'live' || await video.isLive();
    this.duration = this.live ? null : await video.getDurationFromMetadata({ skipLiveWait: true });
    if (this.duration != null) this.duration = Math.max(0, this.duration - start);

    this.canvas.width = width; this.canvas.height = height;
    this.videoTrack = video;
    // Pool of two: only the current and next frame are ever alive (example).
    this.videoSink = new CanvasSink(video, { poolSize: 4, fit: 'contain' });
    this.audioSink = audio ? new AudioBufferSink(audio) : undefined;
    this.position = Math.max(0, request.startAtSeconds ?? 0);

    this.videoEnd = this.audioEnd = this.position;
    if (this.live) await this.refreshLiveWindow(sourceToken);
    if (request.kind === 'live' && this.liveWindow) this.position = this.liveWindow.target;
    await this.publishTracks();
    this.decodedEnd = this.position; this.videoEnd = this.audioEnd = this.position;
    const frame = await this.videoSink.getCanvas(start + this.position);
    if (!this.isCurrent(session) || token !== this.generation) return;
    if (!frame) throw new PlayerOperationError('unsupported-format', 'Mediabunny did not decode an initial video frame.');
    this.draw(frame);
    void input.getMetadataTags().then(tags => {
      if (sourceToken === this.sourceGeneration) this.update(session, { metadata: { title: typeof tags.title === 'string' ? tags.title : undefined, artist: typeof tags.artist === 'string' ? tags.artist : undefined } });
    }).catch(() => undefined);
    this.update(session, { state: 'ready', diagnostics: { firstFrameMs: performance.now() - openedAt, decision: request.deliveryDecision ?? (request.deliveryMode === 'managed' ? 'server-remux' : 'original'), engine: 'mediabunny', networkTransport: '__TAURI_INTERNALS__' in window ? 'native-http' : new URL(request.url, location.href).pathname.startsWith('/media/') ? 'browser-proxy' : 'direct', transport: /\.m3u8(?:[?#]|$)/i.test(request.url) ? 'hls' : 'file', videoCodec: videoConfig?.codec, audioCodec: audioConfig?.codec, width, height }, volume: { level: this.volume, muted: this.muted }, time: this.time() });
    if (request.paused) this.update(session, { state: 'paused' });
    else {
      try { await this.play(); }
      catch (cause) {
        if (!(cause instanceof PlayerOperationError) || cause.code !== 'autoplay-blocked') throw cause;
        this.update(session, { state: 'paused', diagnostics: { ...this.snapshot.diagnostics!, fallbackReason: 'Select Play to enable browser audio.' } });
      }
    }
  }

  async play(): Promise<void> {
    if (this.playing) return;
    if (!this.context || !this.videoSink) throw new PlayerOperationError('invalid-state', 'No prepared MediaBunny session.');
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.context.resume(), new Promise<never>((_, reject) => {
        resumeTimer = setTimeout(() => reject(new PlayerOperationError('autoplay-blocked', 'Select Play to enable browser audio.', undefined, 'autoplay')), 1500);
      })]);
    } finally { clearTimeout(resumeTimer); }
    if (this.context.state !== 'running') throw new PlayerOperationError('autoplay-blocked', 'Select Play to enable browser audio.', undefined, 'autoplay');
    this.playing = true; this.running = false;
    this.bufferingSince = performance.now();
    this.anchor = this.context.currentTime - this.position;
    const token = ++this.generation;
    const session = this.snapshot.sessionId;
    this.videoDone = false; this.audioDone = !this.audioSink;
    this.videoIterator ??= this.videoSink.canvases(this.firstTimestamp + this.position);
    this.audioIterator ??= this.audioSink?.buffers(this.firstTimestamp + this.position);
    this.update(session, { state: 'buffering', error: null });
    void this.videoLoop(token).catch(error => this.decoderFailed(token, error));
    if (this.audioIterator) void this.audioLoop(token).catch(error => this.decoderFailed(token, error));
    const render = () => { if (token !== this.generation) return; this.present(token); this.animation = requestAnimationFrame(render); };
    this.animation = requestAnimationFrame(render);
    this.ticker = setInterval(() => { if (token === this.generation) { this.present(token); this.update(session, { time: this.time() }); } }, 100);
  }

  async pause(): Promise<void> {
    this.position = this.currentPosition(); this.playing = false; this.running = false; this.cancelLoops();
    this.decodedEnd = this.position; this.videoEnd = this.audioEnd = this.position;
    this.update(this.snapshot.sessionId, { state: 'paused', time: this.time() });
  }
  async seek(position: number): Promise<void> {
    if (this.request?.kind === 'live') throw new PlayerOperationError('unsupported-operation', 'Live playback does not expose VOD seeking.');
    if (!Number.isFinite(position) || position < 0) throw new PlayerOperationError('seek-failed', 'Invalid seek position.');
    const resume = this.playing;
    await this.pause();
    this.position = Math.max(0, position - (this.request?.timelineOffsetSeconds ?? 0));
    if (this.duration != null) this.position = Math.min(this.position, this.duration);

    // The decoded window belongs to the old position: reset it before any
    // snapshot is published, or a backwards seek flashes the stale window all
    // the way to the old position before the real one takes over.
    this.decodedEnd = this.position; this.videoEnd = this.audioEnd = this.position;
    this.audioQueue = [];
    const token = this.generation;
    const frame = await this.videoSink?.getCanvas(this.firstTimestamp + this.position);
    if (token !== this.generation) return;
    if (frame) this.draw(frame);
    this.update(this.snapshot.sessionId, { time: this.time() });
    if (!resume) return;
    await this.play();
  }
  async setVolume(level: number): Promise<void> { this.volume = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 1)); if (this.volume > 0) this.muted = false; this.applyVolume(); }
  async setMuted(muted: boolean): Promise<void> { this.muted = muted; this.applyVolume(); }
  async stop(): Promise<void> { this.openingGeneration++; this.invalidateSession(); await this.release(); this.terminal('stopped'); }
  async dispose(): Promise<void> { await this.stop(); this.terminal('disposed'); }
  async selectAudioTrack(id: string): Promise<void> {
    if (!this.videoTrack) return;
    const source = this.sourceGeneration;
    const audio = (await this.videoTrack.getPairableAudioTracks()).find(t => trackId('audio', t.id) === id);
    if (!audio || !await ensureDecodable(audio)) throw new PlayerOperationError('unsupported-format', 'This audio track cannot be decoded.', undefined, 'audio-codec');
    if (source !== this.sourceGeneration) return;
    const resume = this.playing; await this.pause();
    this.audioTrack = audio; this.audioSink = new AudioBufferSink(audio);
    await this.publishTracks(); if (resume) await this.play();
  }
  async loadAudioTracks(): Promise<void> {
    if (!this.videoTrack) return;
    const source = this.sourceGeneration;
    const choices = await audioChoices(this.videoTrack);
    const supported = await Promise.all(choices.tracks.map(track => ensureDecodable(track)));
    if (source !== this.sourceGeneration) return;
    this.update(this.snapshot.sessionId, { tracks: { ...this.snapshot.tracks, audio: choices.choices.map((track, index) => ({ ...track, available: supported[index] })) } });
  }
  private async publishTracks(): Promise<void> {
    if (!this.videoTrack) return;
    const source = this.sourceGeneration;
    const choices = await audioChoices(this.videoTrack);
    if (source !== this.sourceGeneration) return;
    this.update(this.snapshot.sessionId, { tracks: { audio: choices.choices, text: [], selectedAudioId: this.audioTrack ? trackId('audio', this.audioTrack.id) : null, selectedTextId: null }, qualities: this.videoChoices.choices, selectedQualityId: this.qualityId });
  }
  async selectQuality(id: string): Promise<void> {
    this.qualityId = id; this.update(this.snapshot.sessionId, { selectedQualityId: id });
    if (id !== 'auto') await this.switchQuality(id);
  }
  private async switchQuality(id: string): Promise<void> {
    const source = this.sourceGeneration;
    const track = this.videoChoices.tracks.find(t => trackId('video', t.id) === id);
    if (!track || this.switching) return;
    this.switching = true; this.lastSwitch = performance.now();
    try {
      if (!await ensureDecodable(track)) throw new PlayerOperationError('unsupported-format', 'This rendition cannot be decoded.');
      const audio = await chooseAudio(track, { ...this.request!, audioTrackId: this.snapshot.tracks.selectedAudioId ?? undefined });
      if (audio && !await ensureDecodable(audio)) throw new PlayerOperationError('unsupported-format', 'The paired audio cannot be decoded.');
      const sink = new CanvasSink(track, { poolSize: 4, fit: 'contain' });
      const frame = await sink.getCanvas(this.firstTimestamp + this.currentPosition());
      if (source !== this.sourceGeneration) return;
      if (!frame) return;
      const resume = this.playing; await this.pause();
      this.videoTrack = track; this.videoSink = sink; this.audioTrack = audio ?? undefined; this.audioSink = audio ? new AudioBufferSink(audio) : undefined;
      const [width, height, videoConfig, audioConfig] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight(), track.getDecoderConfig(), audio?.getDecoderConfig()]);
      if (source !== this.sourceGeneration) return;
      if (this.snapshot.diagnostics) this.update(this.snapshot.sessionId, { diagnostics: { ...this.snapshot.diagnostics, width, height, videoCodec: videoConfig?.codec, audioCodec: audioConfig?.codec } });
      // Keep the current picture until the new iterator reaches the same clock.
      // The preflight frame may be stale after a slow rendition fetch.
      await this.publishTracks(); if (resume) await this.play();
    } catch (cause) {
      if (canChangeMediaPath(mediaFailure(cause))) this.rejectedQualities.add(id);
      throw cause;
    } finally { this.switching = false; }
  }
  async preview(position: number): Promise<Blob | null> {
    if (!this.videoTrack || this.previewPending || this.snapshot.state === 'buffering') return null;
    this.previewPending = true; const token = this.sourceGeneration;
    try {
      const sink = new CanvasSink(this.videoTrack, { width: 320, height: 180, fit: 'contain', poolSize: 1 });
      const frame = await sink.getCanvas(this.firstTimestamp + Math.max(0, position - (this.request?.timelineOffsetSeconds ?? 0)));
      if (!frame || token !== this.sourceGeneration) return null;
      return 'convertToBlob' in frame.canvas ? frame.canvas.convertToBlob({ type: 'image/webp' }) : new Promise(resolve => (frame.canvas as HTMLCanvasElement).toBlob(resolve, 'image/webp'));
    } catch { return null; } finally { this.previewPending = false; }
  }
  async selectTextTrack(): Promise<void> { throw new PlayerOperationError('unsupported-operation', 'Select subtitles through the playback session.'); }

  /** Keeps a rolling window fresh so the read cursor can follow its edge. */
  private async refreshLiveWindow(token: number): Promise<void> {
    const track = this.videoTrack;
    if (!track || token !== this.sourceGeneration) return;
    const interval = await track.getLiveRefreshInterval().catch(() => null);
    if (token !== this.sourceGeneration || interval === null) return;
    if (this.request?.kind === 'live') {
      const [start, end] = await Promise.all([track.getFirstTimestamp(), track.getDurationFromMetadata({ skipLiveWait: true })]);
      if (end != null) this.liveWindow = { start: Math.max(0, start - this.firstTimestamp), end: end - this.firstTimestamp, target: Math.max(start, end - interval * (2 + Math.min(2, this.liveStalls))) - this.firstTimestamp };
      if (token === this.sourceGeneration) this.update(this.snapshot.sessionId, { time: this.time() });
    }
    if (token === this.sourceGeneration) this.liveRefresh = setTimeout(() => { void this.refreshLiveWindow(token).catch(e => this.decoderFailed(this.generation, e)); }, Math.max(1, interval) * 1000);
  }

  private draw(frame: WrappedCanvas): void {
    const context = this.canvas.getContext('2d');
    if (!context) throw new PlayerOperationError('unsupported-format', 'The video drawing surface is unavailable.', undefined, 'rendering');
    const scale = Math.min(this.canvas.width / frame.canvas.width, this.canvas.height / frame.canvas.height);
    const width = frame.canvas.width * scale, height = frame.canvas.height * scale;
    context.clearRect?.(0, 0, this.canvas.width, this.canvas.height);
    context.drawImage(frame.canvas, (this.canvas.width - width) / 2, (this.canvas.height - height) / 2, width, height);
    if (this.snapshot.diagnostics) this.update(this.snapshot.sessionId, { diagnostics: { ...this.snapshot.diagnostics, presentedPositionSeconds: frame.timestamp - this.firstTimestamp + (this.request?.timelineOffsetSeconds ?? 0) } });
  }
  private currentPosition(): number {
    if (!this.running || !this.context) return this.position;
    const output = this.context.getOutputTimestamp?.();
    const audibleClock = output?.performanceTime && output.contextTime !== undefined
      ? output.contextTime + Math.max(0, performance.now() - output.performanceTime) / 1000
      : this.context.currentTime - (this.context.baseLatency || 0);
    return Math.max(this.position, audibleClock - this.anchor);
  }
  private time() {
    const offset = this.request?.timelineOffsetSeconds ?? 0;
    const engine = this.duration == null ? null : this.duration + offset;
    // A managed delivery is a rolling window; the server total is authoritative
    // and the reported length only ever grows.
    const next = timelineDuration(this.request?.timelineDurationSeconds, engine, this.request?.adoptEngineDuration === true);
    const total = (this.observedTitleDuration = growOnlyDuration(this.observedTitleDuration, next));
    const position = this.currentPosition() + offset;
    // The decoded-ahead window is real evidence for the UI buffer layer; live
    // windows and stalls at the playhead report no lead at all.
    const ahead = this.decodedEnd <= this.currentPosition()
      ? null
      : Math.min(this.decodedEnd + offset, total ?? Number.POSITIVE_INFINITY);
    // An absent key (not null) keeps snapshots deep-equal clean for consumers
    // that never opted into the buffer signal.
    return { positionSeconds: position, durationSeconds: total, ...(ahead != null ? { bufferedEndSeconds: ahead, bufferedRanges: [{ start: position, end: ahead }] } : {}), ...(this.request?.kind === 'live' && this.liveWindow ? { liveWindow: this.liveWindow, seekable: false } : {}) };
  }
  private applyVolume(): void {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
    this.update(this.snapshot.sessionId, { volume: { level: this.volume, muted: this.muted } });
  }
  private async videoLoop(token: number): Promise<void> {
    const iterator = this.videoIterator!;
    while (token === this.generation) {
      while (this.frames.length >= 3 && token === this.generation) await delay(8);
      if (token !== this.generation) return;
      const next = await iterator.next(); if (token !== this.generation) return;
      if (next.done) { this.videoDone = true; return; }
      this.frames.push(next.value); this.videoEnd = Math.max(this.videoEnd, next.value.timestamp - this.firstTimestamp + next.value.duration);
    }
  }
  private async audioLoop(token: number): Promise<void> {
    const iterator = this.audioIterator!;
    while (token === this.generation) {
      while ((this.audioQueue.length >= this.audioQueueLimit || this.audioEnd - this.currentPosition() > 2) && token === this.generation) await delay(20);
      if (token !== this.generation) return;
      const next = await iterator.next(); if (token !== this.generation) return;
      if (next.done) { this.audioDone = true; return; }
      this.audioQueue.push(next.value); this.audioEnd = Math.max(this.audioEnd, next.value.timestamp - this.firstTimestamp + next.value.buffer.duration);
    }
  }
  private present(token: number): void {
    if (!this.playing || !this.context || token !== this.generation) return;
    let position = this.currentPosition();
    if (!this.running && (this.videoDone || this.frames.length > 0) && (this.audioDone || this.audioEnd > position + 0.08)) {
      this.anchor = this.context.currentTime - this.position; this.running = true; position = this.position;
      this.update(this.snapshot.sessionId, { state: 'playing', error: null });
    }
    if (this.running && ((!this.videoDone && !this.frames.length && this.videoEnd < position) || (!this.audioDone && this.audioEnd < position + 0.015))) {
      this.position = position; this.running = false; this.stopNodes(); this.liveStalls++; this.bufferingSince = performance.now(); this.update(this.snapshot.sessionId, { state: 'buffering' });
    }
    this.decodedEnd = this.audioSink ? Math.min(this.videoEnd, this.audioEnd) : this.videoEnd;
    if (!this.running) {
      if (this.request?.kind === 'live' && performance.now() - this.bufferingSince > 15000) {
        if (this.lastLiveReconnect && performance.now() - this.lastLiveReconnect < 60000) {
          this.decoderFailed(token, new PlayerOperationError('connection-failed', 'The live stream is not advancing.', undefined, 'network'));
        } else {
          this.lastLiveReconnect = performance.now();
          const opening = this.openingGeneration + 1;
          void this.open({ ...this.request, startAtSeconds: 0, paused: false }).catch(cause => {
            if (opening === this.openingGeneration) this.fail(this.snapshot.sessionId, mediaFailure(cause).toFailure());
          });
        }
      }
      return;
    }
    let frame: WrappedCanvas | undefined;
    while (this.frames.length && this.frames[0].timestamp - this.firstTimestamp <= position + 0.004) { if (frame) this.dropped++; frame = this.frames.shift(); }
    if (frame) {
      this.draw(frame); this.presented++;
      if (this.snapshot.diagnostics) this.update(this.snapshot.sessionId, { diagnostics: { ...this.snapshot.diagnostics, estimatedAvSkewMs: Math.abs(position - (frame.timestamp - this.firstTimestamp)) * 1000 } });
    }
    while (this.audioQueue.length && this.audioQueue[0].timestamp - this.firstTimestamp + this.audioQueue[0].buffer.duration <= position) this.scheduled.delete(this.audioQueue.shift()!);
    for (const packet of this.audioQueue) {
      const relative = packet.timestamp - this.firstTimestamp;
      if (relative > position + 0.35) break;
      if (this.scheduled.has(packet) || !this.gain) continue;
      const offset = Math.max(0, position - relative); if (offset >= packet.buffer.duration) continue;
      const node = this.context.createBufferSource(); node.buffer = packet.buffer; node.connect(this.gain); this.nodes.add(node); this.scheduled.add(packet);
      node.onended = () => { this.nodes.delete(node); node.disconnect(); };
      const timestamp = Math.round((this.anchor + relative) * this.context.sampleRate) / this.context.sampleRate;
      node.start(Math.max(this.context.currentTime, timestamp), offset);
    }
    if (this.videoDone && this.audioDone && !this.frames.length && !this.nodes.size && position >= Math.max(this.videoEnd, this.audioEnd)) {
      this.position = position; this.playing = false; this.running = false; this.cancelLoops(); this.update(this.snapshot.sessionId, { state: 'ended', time: this.time() }); return;
    }
    if (this.snapshot.diagnostics) this.update(this.snapshot.sessionId, { diagnostics: { ...this.snapshot.diagnostics, presentedFrames: this.presented, droppedFrames: this.dropped } });
    if (performance.now() - this.performanceStart > 10000 && this.presented > 240 && this.dropped / (this.presented + this.dropped) > 0.05) {
      this.decoderFailed(token, new PlayerOperationError('performance-limited', 'This playback path cannot sustain the frame rate.', undefined, 'performance')); return;
    }
    if (this.qualityId === 'auto' && this.videoTrack && !this.switching && performance.now() - this.lastSwitch > 1500) {
      const id = trackId('video', this.videoTrack.id);
      const choice = this.adaptive.choose(this.videoChoices.choices.filter(q => !this.rejectedQualities.has(q.id)), id, this.decodedEnd - position, performance.now());
      if (choice !== id) void this.switchQuality(choice).catch(() => undefined);
    }
  }
  private stopNodes(): void {
    for (const node of this.nodes) { node.onended = null; try { node.stop(); } catch {} node.disconnect(); }
    this.nodes.clear(); this.scheduled.clear();
  }
  private decoderFailed(token: number, cause: unknown): void {
    if (token !== this.generation) return;
    this.position = this.currentPosition(); this.playing = false; this.running = false; this.cancelLoops();
    this.update(this.snapshot.sessionId, { time: this.time() });
    this.fail(this.snapshot.sessionId, mediaFailure(cause, 'video-codec').toFailure());
  }
  private cancelLoops(): void {
    this.generation++;
    clearInterval(this.ticker); this.ticker = undefined;
    if (this.animation !== undefined) cancelAnimationFrame(this.animation); this.animation = undefined; this.frames = [];
    // return() may wait for a live read; disposal below aborts the source on stop.
    void this.videoIterator?.return().catch(() => undefined);
    void this.audioIterator?.return().catch(() => undefined);
    this.videoIterator = undefined; this.audioIterator = undefined; this.audioQueue = [];
    for (const node of this.nodes) { node.onended = null; try { node.stop(); } catch { /* already ended */ } node.disconnect(); }
    this.nodes.clear(); this.scheduled.clear();
  }
  private async release(): Promise<void> {
    this.sourceGeneration++; clearTimeout(this.liveRefresh); this.liveRefresh = undefined; this.liveWindow = undefined;
    this.playing = false; this.running = false; this.cancelLoops(); this.input?.dispose(); this.input = undefined;
    this.videoSink = undefined; this.videoTrack = undefined; this.audioSink = undefined;
    const context = this.context; this.context = undefined; this.gain = undefined;
    if (context && context.state !== 'closed') await context.close();
  }
}

/**
 * MediaBunny decodes whatever WebCodecs supports plus PCM; Dolby, DTS and ProRes
 * ship as separate decoders. They are pulled in only when a real track needs one,
 * so ordinary playback pays no extra download, and loaded once per page.
 */
const loadedExtensions = new Map<string, Promise<void>>();
async function loadCodecExtension(codec: string): Promise<void> {
  const name = codec === 'ac3' || codec === 'eac3' ? 'ac3' : codec === 'dts' ? 'dts' : codec === 'prores' ? 'prores' : undefined;
  if (!name) return;
  let pending = loadedExtensions.get(name);
  if (!pending) {
    pending = (async () => {
      if (name === 'ac3') { const { registerAc3Decoder } = await import('@mediabunny/ac3'); registerAc3Decoder(); }
      else if (name === 'dts') { const { registerDtsDecoder } = await import('@mediabunny/dts'); registerDtsDecoder(); }
      else { const { registerProresDecoder } = await import('@mediabunny/prores'); registerProresDecoder(); }
    })().catch(cause => { loadedExtensions.delete(name); throw cause; });
    loadedExtensions.set(name, pending);
  }
  return pending;
}

/** Registers the matching decoder when a track's own codec is not decodable yet. */
export async function ensureDecodable(track: InputTrack | null | undefined): Promise<boolean> {
  if (!track) return false;
  const check = async () => {
    try { return await track.canDecode(); }
    catch (cause) { if (cause instanceof PlayerOperationError && !canChangeMediaPath(cause)) throw cause; return false; }
  };
  if (await check()) return true;
  const codec = await track.getCodec();
  if (!codec) return false;
  await loadCodecExtension(codec);
  return check();
}

/** Video and audio codecs this client can decode, for the server's delivery choice. */
export async function decodableCodecs(): Promise<{ video: string[]; audio: string[] }> {
  const { getDecodableVideoCodecs, getDecodableAudioCodecs } = await import('mediabunny');
  const [video, audio] = await Promise.all([
    getDecodableVideoCodecs(['avc', 'hevc', 'vp8', 'vp9', 'av1']).catch(() => []),
    getDecodableAudioCodecs(['aac', 'opus', 'mp3', 'vorbis', 'flac', 'ac3', 'eac3', 'dts']).catch(() => []),
  ]);
  // The extension decoders ship with this bundle, so Dolby and DTS are decodable
  // on demand even where the browser itself cannot.
  return { video, audio };
}
