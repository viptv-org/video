import { ALL_FORMATS, Input, UrlSource, Output, Mp4OutputFormat, StreamTarget, Conversion, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, type InputVideoTrack, type InputAudioTrack } from 'mediabunny';
import { SessionPlayer } from './session-player';
import { hasSourceAuthorization } from './source-authorization';
import { PlayerOperationError, timelineDuration, type OpenPlayerRequest, type PlayerCapabilities } from './types';
import { sessionMediaFetch } from './session-media-fetch';
import { mediaFailure } from './browser-policy';
import { audioChoices, chooseAudio, trackId, videoChoices } from './media-tracks';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const MSE_COPY_CAPABILITIES: PlayerCapabilities = {
  platform: 'html5', engine: 'Mediabunny packet copy / MSE', directNative: 'probe-required', adaptiveStreaming: 'probe-required', drm: 'unsupported',
  canPause: true, canSeek: true, canSetVolume: true, canSelectAudioTrack: true, canSelectTextTrack: false, canDisableTextTrack: false,
  canUseCookies: false, canUseUserAgent: false, limitations: ['Selected codecs must be supported by MSE; this path never encodes media.'],
};

/** Copies encoded tracks incrementally; the native video decoder owns AV sync. */
export class MediabunnyMseAdapter extends SessionPlayer {
  readonly capabilities = MSE_COPY_CAPABILITIES;
  private input?: Input;
  private conversion?: Conversion;
  private output?: Output;
  private objectUrl?: string;
  private abort = new AbortController();
  private request?: OpenPlayerRequest;
  private origin = 0;
  private duration: number | null = null;
  private handlers: Array<[string, EventListener]> = [];
  private volume = 1;
  private muted = false;
  private generation = 0;
  private maximumAhead = 20;
  private backBuffer = 10;
  private frameClockVerified = false;
  private frameObserver?: number;

  constructor(private readonly media: HTMLVideoElement) { super(); }
  async open(request: OpenPlayerRequest): Promise<void> {
    if (hasSourceAuthorization(request.authorization)) throw new PlayerOperationError('authorization-unsupported', 'This source requires gateway delivery for its request headers.');
    if (this.request?.url !== request.url || this.request?.qualityId !== request.qualityId) this.frameClockVerified = false;
    const generation = ++this.generation;
    await this.release();
    if (generation !== this.generation) return;
    this.request = request;
    this.maximumAhead = 20; this.backBuffer = 10;
    const openedAt = performance.now();
    const session = this.startSession(request.kind), signal = this.abort.signal;
    if (typeof MediaSource === 'undefined') throw new PlayerOperationError('unsupported-format', 'MediaSource is unavailable.', undefined, 'container');
    const input = this.input = new Input({ source: new UrlSource(request.url, { maxCacheSize: 32 * 1024 * 1024, fetchFn: sessionMediaFetch(request.url) }), formats: ALL_FORMATS,
      formatOptions: { hls: { offsetTimestampsByDateTime: false } } });
    try {
      const videos = await videoChoices(input);
      const video = videos.tracks.find(t => trackId('video', t.id) === request.qualityId) ?? await input.getPrimaryVideoTrack() ?? undefined;
      if (!video) throw new PlayerOperationError('unsupported-format', 'No copyable video track.', undefined, 'video-codec');
      if (request.maximumHeight && await video.getDisplayHeight() > request.maximumHeight) throw new PlayerOperationError('unsupported-format', 'The selected quality requires a smaller rendition.', undefined, 'rendering');
      const audio = await chooseAudio(video, request);
      const codecs = await Promise.all([video, ...(audio ? [audio] : [])].map(t => t.getCodecParameterString()));
      if (signal.aborted) { input.dispose(); return; }
      if (codecs.some(c => !c)) throw new PlayerOperationError('unsupported-format', 'The selected tracks cannot be repackaged.', undefined, 'container');
      const mime = `video/mp4; codecs="${codecs.join(',')}"`;
      if (!MediaSource.isTypeSupported(`video/mp4; codecs="${codecs[0]}"`)) throw new PlayerOperationError('unsupported-format', 'The native decoder does not support this video.', undefined, 'video-codec');
      if (audio && !MediaSource.isTypeSupported(`audio/mp4; codecs="${codecs[1]}"`)) throw new PlayerOperationError('unsupported-format', 'The native decoder does not support this audio.', undefined, 'audio-codec');
      if (!MediaSource.isTypeSupported(mime)) throw new PlayerOperationError('unsupported-format', 'The selected tracks cannot share this container.', undefined, 'container');
      const first = await video.getFirstTimestamp();
      const live = request.kind === 'live' || await video.isLive();
      const sequentialLive = request.kind === 'live' && !await video.isLive();
      this.duration = live ? null : await video.getDurationFromMetadata({ skipLiveWait: true });
      if (this.duration != null) this.duration -= first;
      let start = first + (request.startAtSeconds ?? 0);
      if (request.kind === 'live' && !sequentialLive) {
        const edge = await video.getDurationFromMetadata({ skipLiveWait: true });
        const interval = await video.getLiveRefreshInterval();
        if (edge != null) start = Math.max(first, edge - 2 * (interval ?? 2));
      }
      const requestedStart = start;
      const packets = new EncodedPacketSink(video);
      const key = start <= first + 0.001 ? await packets.getFirstKeyPacket({ metadataOnly: true })
        : await packets.getKeyPacket(start, { metadataOnly: true }) ?? await packets.getFirstKeyPacket({ metadataOnly: true });
      if (!key) throw new PlayerOperationError('unsupported-format', 'No decodable starting keyframe.', undefined, 'container');
      start = key.timestamp;
      const preroll = Math.max(0, requestedStart - start);
      this.origin = (request.timelineOffsetSeconds ?? 0) + start - first;
      if (signal.aborted) { input.dispose(); return; }
      const source = new MediaSource();
      this.objectUrl = URL.createObjectURL(source);
      const opened = this.event(source, 'sourceopen', signal);
      this.media.src = this.objectUrl;
      this.observeFrameClock(signal);
      this.media.volume = this.volume; this.media.muted = this.muted;
      await opened;
      if (signal.aborted) return;
      const buffer = source.addSourceBuffer(mime);
      let written = 0;
      const target = new StreamTarget(new WritableStream({ write: async ({ data, position }: { data: Uint8Array; position: number }) => {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (position !== written) throw new Error('Non-sequential fragmented output');
        for (;;) {
          while (!signal.aborted && this.bufferedAhead() > this.maximumAhead) await sleep(50);
          if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          if (this.media.currentTime > this.backBuffer && buffer.buffered.length && buffer.buffered.start(0) < this.media.currentTime - this.backBuffer) {
            await this.event(buffer, 'updateend', signal, () => buffer.remove(0, this.media.currentTime - this.backBuffer));
          }
          try { await this.event(buffer, 'updateend', signal, () => buffer.appendBuffer(data as Uint8Array<ArrayBuffer>)); break; }
          catch (cause) {
            if (!(cause instanceof DOMException) || cause.name !== 'QuotaExceededError') throw cause;
            if (!buffer.buffered.length || this.bufferedAhead() < 0.25) throw new PlayerOperationError('performance-limited', 'This media fragment exceeds the device buffer capacity.', undefined, 'performance');
            this.maximumAhead = Math.max(4, this.maximumAhead / 2); this.backBuffer = 2;
            await sleep(100);
          }
        }
        written += data.byteLength;
      } }), { chunked: false });
      const output = this.output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }), target });
      let execute: () => Promise<void>;
      if (sequentialLive) {
        // Conversion computes duration for ordinary files, including an endless
        // transport stream. Pipe encoded packets directly so live needs no EOF.
        execute = await this.prepareLiveCopy(output, video, audio, start, signal);
      } else {
        const conversion = this.conversion = await Conversion.init({ input, output, tracks: 'all', trim: { start },
          video: t => ({ discard: t !== video }), audio: t => ({ discard: t !== audio }),
          copy: { mode: 'forced', shiftTolerance: Infinity, boundaryPolicy: 'expand' }, showWarnings: false });
        const required = [video, ...(audio ? [audio] : [])];
        if (!conversion.isValid || required.some(t => !conversion.utilizedTracks.includes(t)))
          throw new PlayerOperationError('unsupported-format', 'Required media tracks cannot be copied.', undefined, 'container');
        execute = () => conversion.execute();
      }
      const choices = await audioChoices(video);
      let warmingFrame = false;
      this.update(session, { tracks: { audio: choices.choices, text: [], selectedAudioId: audio ? trackId('audio', audio.id) : null, selectedTextId: null },
        qualities: videos.choices, selectedQualityId: request.qualityId ?? 'auto',
        diagnostics: { engine: 'mediabunny-mse', transport: request.deliveryFormat === 'hls' ? 'hls' : 'file', networkTransport: 'browser-proxy', decision: 'local-remux', videoCodec: codecs[0]!, audioCodec: codecs[1] ?? undefined, width: await video.getDisplayWidth(), height: await video.getDisplayHeight() } });
      this.bind('timeupdate', () => this.publishTime(session));
      this.bind('waiting', () => { if (!warmingFrame) this.update(session, { state: 'buffering' }); });
      this.bind('playing', () => { if (!warmingFrame) this.update(session, { state: 'playing', error: null }); });
      this.bind('pause', () => { if (!warmingFrame && !this.media.ended) this.update(session, { state: 'paused' }); });
      this.bind('ended', () => this.update(session, { state: 'ended' }));
      this.bind('error', () => this.fail(session, new PlayerOperationError('unsupported-format', 'Native decoding of copied media failed.', undefined, 'video-codec').toFailure()));
      const ready = this.event(this.media, 'loadeddata', signal);
      const execution = execute().then(() => { if (!signal.aborted && source.readyState === 'open') source.endOfStream(); });
      void execution.catch(cause => { if (!signal.aborted) this.fail(session, mediaFailure(cause).toFailure()); });
      await Promise.race([ready, execution.then(() => ready)]);
      if (signal.aborted) return;
      if (preroll > 0.001) {
        const presented = this.waitForFrame(preroll, signal, 200);
        await this.event(this.media, 'seeked', signal, () => { this.media.currentTime = preroll; });
        if (request.paused && await presented === false && !signal.aborted) {
          // Some TV decoders acknowledge a paused seek before presenting it.
          // Advance one muted frame, then restore the viewer's pause intent.
          warmingFrame = true;
          const muted = this.media.muted; this.media.muted = true;
          try {
            const frame = this.waitForFrame(preroll, signal, 2500);
            await this.media.play();
            if (!await frame && !signal.aborted) throw new PlayerOperationError('seek-failed', 'The TV did not present the requested seek frame.');
          } finally { if (generation === this.generation && !signal.aborted) { this.media.pause(); this.media.muted = muted; } warmingFrame = false; }
        }
      }
      this.publishTime(session);
      this.update(session, { state: request.paused ? 'paused' : 'ready', diagnostics: this.snapshot.diagnostics ? { ...this.snapshot.diagnostics, firstFrameMs: performance.now() - openedAt } : undefined });
      if (!request.paused) await this.play();
    } catch (cause) { if (!signal.aborted) throw mediaFailure(cause); }
  }
  private async prepareLiveCopy(output: Output, video: InputVideoTrack, audio: InputAudioTrack | null, start: number, signal: AbortSignal): Promise<() => Promise<void>> {
    const videoCodec = await video.getCodec(), videoConfig = await video.getDecoderConfig();
    const audioCodec = audio ? await audio.getCodec() : null, audioConfig = audio ? await audio.getDecoderConfig() : null;
    if (!videoCodec || !videoConfig || audio && (!audioCodec || !audioConfig))
      throw new PlayerOperationError('unsupported-format', 'Required live tracks cannot be copied.', undefined, 'container');
    const videoSource = new EncodedVideoPacketSource(videoCodec);
    output.addVideoTrack(videoSource);
    const audioSource = audioCodec ? new EncodedAudioPacketSource(audioCodec) : null;
    if (audioSource) output.addAudioTrack(audioSource);
    return async () => {
      await output.start();
      const videoPackets = new EncodedPacketSink(video);
      const first = await videoPackets.getFirstKeyPacket();
      if (!first) throw new PlayerOperationError('unsupported-format', 'Live source has no keyframe.', undefined, 'container');
      await Promise.all([
        (async () => {
          for await (const packet of videoPackets.packets(first)) {
            if (signal.aborted) return;
            await videoSource.add(packet.clone({ timestamp: packet.timestamp - start }), { decoderConfig: videoConfig });
          }
          videoSource.close();
        })(),
        (async () => {
          if (!audio || !audioSource || !audioConfig) return;
          for await (const packet of new EncodedPacketSink(audio).packets()) {
            if (signal.aborted) return;
            if (packet.timestamp < start) continue;
            await audioSource.add(packet.clone({ timestamp: packet.timestamp - start }), { decoderConfig: audioConfig });
          }
          audioSource.close();
        })(),
      ]);
      if (!signal.aborted) await output.finalize();
    };
  }
  private bufferedAhead(): number { const b = this.media.buffered; return b.length ? Math.max(0, b.end(b.length - 1) - this.media.currentTime) : 0; }
  private publishTime(session: number): void {
    const bufferedRanges = Array.from({ length: this.media.buffered.length }, (_, i) => ({ start: this.origin + this.media.buffered.start(i), end: this.origin + this.media.buffered.end(i) }));
    this.update(session, { time: { positionSeconds: this.origin + this.media.currentTime,
      durationSeconds: timelineDuration(this.request?.timelineDurationSeconds, this.duration, this.request?.adoptEngineDuration),
      bufferedRanges, bufferedEndSeconds: bufferedRanges[bufferedRanges.length - 1]?.end }, volume: { level: this.volume, muted: this.muted } });
    if (this.snapshot.diagnostics) this.update(session, { diagnostics: { ...this.snapshot.diagnostics, frameTiming: this.frameClockVerified ? 'verified' : 'unavailable' } });
  }
  private bind(name: string, fn: EventListener): void { this.media.addEventListener(name, fn); this.handlers.push([name, fn]); }
  private observeFrameClock(signal: AbortSignal): void {
    if (!this.media.requestVideoFrameCallback) return;
    let previous: number | undefined;
    const frame: VideoFrameRequestCallback = (_, metadata) => {
      if (signal.aborted) return;
      if (previous !== undefined && metadata.mediaTime > previous + 0.001) this.frameClockVerified = true;
      previous = metadata.mediaTime;
      this.frameObserver = this.media.requestVideoFrameCallback(frame);
    };
    this.frameObserver = this.media.requestVideoFrameCallback(frame);
  }
  private waitForFrame(position: number, signal: AbortSignal, milliseconds: number): Promise<boolean | null> {
    if (!this.media.requestVideoFrameCallback || !this.frameClockVerified) return Promise.resolve(null);
    return new Promise(resolve => {
      let id: number | undefined;
      const finish = (shown: boolean) => { clearTimeout(timer); if (id !== undefined) this.media.cancelVideoFrameCallback(id); signal.removeEventListener('abort', abort); resolve(shown); };
      const abort = () => finish(false);
      const frame: VideoFrameRequestCallback = (_, metadata) => {
        if (Math.abs(metadata.mediaTime - position) <= 0.08) finish(true);
        else id = this.media.requestVideoFrameCallback(frame);
      };
      const timer = setTimeout(() => finish(false), milliseconds);
      id = this.media.requestVideoFrameCallback(frame); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  private event(target: EventTarget, name: string, signal: AbortSignal, trigger?: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); target.removeEventListener(name, ready); target.removeEventListener('error', error); signal.removeEventListener('abort', abort); };
      const ready = () => { clean(); resolve(); };
      const error = () => { clean(); reject(new PlayerOperationError('unsupported-format', 'Copied media could not be appended.', undefined, 'container')); };
      const abort = () => { clean(); reject(new DOMException('Cancelled', 'AbortError')); };
      const timer = setTimeout(() => { clean(); reject(new PlayerOperationError('connection-failed', 'Media preparation timed out.', undefined, 'network')); }, 15000);
      target.addEventListener(name, ready, { once: true }); target.addEventListener('error', error, { once: true }); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else if (trigger) { try { trigger(); } catch (cause) { clean(); reject(cause); } }
    });
  }
  async play(): Promise<void> { try { await this.media.play(); } catch (cause) { throw mediaFailure(cause); } }
  async pause(): Promise<void> { this.media.pause(); }
  async seek(position: number): Promise<void> {
    if (!this.request || this.request.kind === 'live') throw new PlayerOperationError('unsupported-operation', 'This stream cannot seek.');
    const request = { ...this.request, startAtSeconds: Math.max(0, position - (this.request.timelineOffsetSeconds ?? 0)), paused: this.media.paused };
    await this.replace(request);
  }
  private async replace(request: OpenPlayerRequest): Promise<void> {
    const previous = this.request ? { ...this.request, startAtSeconds: Math.max(0, this.snapshot.time.positionSeconds - (this.request.timelineOffsetSeconds ?? 0)), paused: this.media.paused } : undefined;
    const previousTime = this.snapshot.time;
    const attempt = this.generation + 1;
    try { await this.open(request); }
    catch (cause) {
      if (attempt !== this.generation) return;
      if (previous) {
        try { await this.open(previous); }
        catch (restore) { this.update(this.snapshot.sessionId, { state: 'error', time: previousTime, error: mediaFailure(restore).toFailure() }); }
      }
      throw cause;
    }
  }
  async loadAudioTracks(): Promise<void> {
    const generation = this.generation;
    const video = await this.input?.getPrimaryVideoTrack(); if (!video) return;
    const { tracks, choices } = await audioChoices(video);
    const available = await Promise.all(tracks.map(async track => MediaSource.isTypeSupported(`audio/mp4; codecs="${await track.getCodecParameterString()}"`)));
    if (generation === this.generation) this.update(this.snapshot.sessionId, { tracks: { ...this.snapshot.tracks, audio: choices.map((choice, index) => ({ ...choice, available: available[index] })) } });
  }
  async selectAudioTrack(id: string): Promise<void> {
    await this.loadAudioTracks();
    if (!this.snapshot.tracks.audio.some(track => track.id === id && track.available)) throw new PlayerOperationError('unsupported-format', 'This audio requires compatible delivery.', undefined, 'audio-codec');
    if (this.request) await this.replace({ ...this.request, audioTrackId: id, startAtSeconds: this.snapshot.time.positionSeconds - (this.request.timelineOffsetSeconds ?? 0), paused: this.media.paused });
  }
  async selectQuality(id: string): Promise<void> { if (this.request) await this.replace({ ...this.request, qualityId: id, startAtSeconds: this.snapshot.time.positionSeconds - (this.request.timelineOffsetSeconds ?? 0), paused: this.media.paused }); }
  async selectTextTrack(): Promise<void> { throw new PlayerOperationError('unsupported-operation', 'This subtitle requires the session subtitle path.'); }
  async setVolume(level: number): Promise<void> { this.volume = Math.max(0, Math.min(1, level)); this.media.volume = this.volume; }
  async setMuted(muted: boolean): Promise<void> { this.muted = muted; this.media.muted = muted; }
  async stop(): Promise<void> { this.generation++; this.invalidateSession(); await this.release(); this.terminal('stopped'); }
  async dispose(): Promise<void> { await this.stop(); this.terminal('disposed'); }
  private async release(): Promise<void> {
    if (this.frameObserver !== undefined) this.media.cancelVideoFrameCallback?.(this.frameObserver);
    this.frameObserver = undefined;
    this.abort.abort(); this.input?.dispose(); this.input = undefined;
    void this.conversion?.cancel().catch(() => undefined); this.conversion = undefined;
    void this.output?.cancel().catch(() => undefined); this.output = undefined;
    for (const [name, handler] of this.handlers) this.media.removeEventListener(name, handler); this.handlers = [];
    this.media.pause(); this.media.removeAttribute('src'); this.media.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined; this.abort = new AbortController();
  }
}
