import { VizioHtml5Adapter, VIZIO_HTML5_CAPABILITIES, type HtmlMediaLike } from './vizio-html5';
import { IDLE_SNAPSHOT, PlayerOperationError, type OpenPlayerRequest, type Player, type PlayerCapabilities, type PlayerListener, type PlayerSnapshot } from './types';
import { browserPlaybackPolicy, canChangeMediaPath, mediaFailure } from './browser-policy';
import { BrowserCaptions } from './captions';
import { sessionMediaFetch } from './session-media-fetch';
import { audioChoices, mediaLanguage } from './media-tracks';

/** WebCodecs availability is a gate, never proof that the selected track decodes. */
export function mediabunnyUnavailable(canvas?: HTMLCanvasElement): string | undefined {
  if (!canvas) return 'A MediaBunny drawing surface is unavailable.';
  if (!globalThis.isSecureContext) return 'WebCodecs requires HTTPS or a trusted local context.';
  if (typeof BigInt === 'undefined' || typeof VideoDecoder === 'undefined' || typeof AudioContext === 'undefined')
    return 'This runtime does not expose the required WebCodecs and Web Audio APIs.';
  return undefined;
}

/** Prefer real decoded samples; failure retains the exact delivery URL and backend lease. */
export class Html5FallbackAdapter implements Player {
  get capabilities(): PlayerCapabilities { return { ...(this.active?.capabilities ?? VIZIO_HTML5_CAPABILITIES), platform: this.platform, canSetVolume: true,
    ...(this.inspectedAudio.length ? { canSelectAudioTrack: true } : {}), ...(this.captions ? { canSelectTextTrack: true, canDisableTextTrack: true } : {}) }; }
  private active?: Player;
  private unsubscribe?: () => void;
  private listeners = new Set<PlayerListener>();
  private value: PlayerSnapshot = IDLE_SNAPSHOT;
  private generation = 0;
  private request?: OpenPlayerRequest;
  private opening = false;
  private recovering = false;
  private fallbackReason?: string;
  private volume = 1;
  private muted = false;
  private pausedIntent = false;
  private cancelOpening?: () => void;
  private paths: Array<'bunny' | 'native' | 'mse'> = [];
  private captions?: BrowserCaptions;
  private captionTracks: PlayerSnapshot['tracks']['text'] = [];
  private captionId: string | null = null;
  private captionText: readonly string[] = [];
  private inspectedAudio: PlayerSnapshot['tracks']['audio'] = [];
  private audioInspector?: { dispose(): void };
  constructor(private readonly media: HtmlMediaLike, private readonly canvas?: HTMLCanvasElement, private readonly platform: 'html5' | 'vizio' = 'html5') {}
  get snapshot(): PlayerSnapshot { return this.value; }
  subscribe(listener: PlayerListener): () => void { this.listeners.add(listener); listener(this.value); return () => this.listeners.delete(listener); }

  async open(request: OpenPlayerRequest): Promise<void> {
    const generation = ++this.generation;
    this.cancelOpening?.(); this.cancelOpening = undefined;
    this.clearSubscription(); this.unsubscribe = undefined;
    const previous = this.active; this.active = undefined; await previous?.dispose();
    if (generation !== this.generation) return;
    this.pausedIntent = request.paused ?? false;
    this.audioInspector?.dispose(); this.audioInspector = undefined; this.inspectedAudio = [];
    this.captions?.dispose(); this.captions = undefined; this.captionTracks = []; this.captionText = []; this.captionId = null;
    if (browserPlaybackPolicy().clientInspection && request.deliveryMode === 'direct') this.captions = new BrowserCaptions(request.url, (tracks, selected, captions) => {
      if (generation !== this.generation) return;
      this.captionTracks = tracks; this.captionId = selected; this.captionText = captions;
    });
    this.request = request; this.opening = true; this.recovering = false; this.fallbackReason = undefined;
    this.publish({ ...IDLE_SNAPSHOT, sessionId: generation, kind: request.kind, state: 'opening' });
    const unavailable = mediabunnyUnavailable(this.canvas);
    this.paths = unavailable ? ['native'] : ['bunny', 'native'];
    // Managed continuous MP4 has one bounded response body; a second local
    // consumer cannot reopen it. A native refusal needs a replacement session.
    if (request.deliveryFormat === 'fmp4') this.paths = ['native'];
    if (request.deliveryFormat !== 'fmp4' && browserPlaybackPolicy().localRemux && typeof BigInt !== 'undefined' && typeof MediaSource !== 'undefined' && this.media instanceof HTMLVideoElement) this.paths.push('mse');
    this.fallbackReason = unavailable;
    try {
      const preparePaused = request.paused || !!request.preferredSubtitleLanguage;
      await this.nextPath({ ...request, paused: preparePaused }, generation);
      if (generation !== this.generation) return;
      const playingAudio = this.value.tracks.audio.find(track => track.id === this.value.tracks.selectedAudioId);
      if (request.preferredAudioLanguage && (!playingAudio?.language || mediaLanguage(playingAudio.language) !== mediaLanguage(request.preferredAudioLanguage))) {
        await this.loadAudioTracks(false);
        if (generation !== this.generation) return;
        let selected = this.value.tracks.audio.find(track => track.language && mediaLanguage(track.language) === mediaLanguage(request.preferredAudioLanguage!));
        if (selected && !selected.available) { await this.serverAudioChoices(); selected = this.value.tracks.audio.find(track => track.language && mediaLanguage(track.language) === mediaLanguage(request.preferredAudioLanguage!)); }
        if (selected?.delivery === 'server' && selected.inputIndex !== undefined) throw new PlayerOperationError('unsupported-format', 'Preferred audio requires compatible delivery.', undefined, 'audio-codec', { audioTrackIndex: selected.inputIndex });
        if (selected?.available && this.value.tracks.selectedAudioId !== selected.id) await this.selectAudioTrack(selected.id);
      }
      if (request.preferredSubtitleLanguage) {
        try {
          await this.loadTextTracks();
          if (generation !== this.generation) return;
          const selected = this.value.tracks.text.find(track => track.available && track.language && mediaLanguage(track.language) === mediaLanguage(request.preferredSubtitleLanguage!));
          if (selected) await this.selectTextTrack(selected.id);
          else this.publish({ ...this.value, notice: 'Preferred subtitles are unavailable.' });
        } catch { if (generation === this.generation) this.publish({ ...this.value, notice: 'Subtitles could not be loaded.' }); }
        if (!request.paused && generation === this.generation) {
          try { await this.requireActive().play(); }
          catch (cause) { const error = mediaFailure(cause); if (error.code !== 'autoplay-blocked') throw error; this.publish({ ...this.value, state: 'paused', notice: 'Select Play to enable browser audio.' }); }
        }
      }
    } finally { if (generation === this.generation) { this.opening = false; this.cancelOpening = undefined; } }
  }
  private async nextPath(request: OpenPlayerRequest, generation: number): Promise<void> {
    while (this.paths.length && generation === this.generation) {
      const path = this.paths.shift()!;
      let player: Player;
      if (path === 'bunny') {
        const { MediabunnyAdapter } = await import('./mediabunny');
        if (generation !== this.generation) return;
        player = new MediabunnyAdapter(this.canvas!);
      } else if (path === 'mse') {
        const { MediabunnyMseAdapter } = await import('./mediabunny-mse');
        if (generation !== this.generation) return;
        player = new MediabunnyMseAdapter(this.media as HTMLVideoElement);
      } else player = new VizioHtml5Adapter(this.media);
      this.attach(player, generation, path === 'bunny');
      try {
        await withTimeout(Promise.race([player.open(request), new Promise<void>(resolve => { this.cancelOpening = resolve; })]), 15000);
        return;
      } catch (cause) {
        if (generation !== this.generation) return;
        const error = mediaFailure(cause);
        this.clearSubscription(); await player.dispose();
        if (!canChangeMediaPath(error) || !this.paths.length) throw error;
        this.fallbackReason = `${path} could not present these tracks; trying the next local playback path.`;
      }
    }
  }
  private attach(player: Player, generation: number, bunny: boolean): void {
    this.clearSubscription(); this.active = player;
    this.showCanvas(bunny);
    void player.setVolume?.(this.volume); void player.setMuted?.(this.muted);
    this.unsubscribe = player.subscribe(snapshot => {
      if (generation !== this.generation || this.active !== player) return;
      if (snapshot.state === 'error' && snapshot.error && canChangeMediaPath(snapshot.error) && this.paths.length && !this.opening && !this.recovering) {
        void this.recover(generation, snapshot); return;
      }
      if (snapshot.state === 'idle') return;
      this.captions?.tick(snapshot.time.positionSeconds);
      this.publish({ ...snapshot, sessionId: generation, tracks: { ...snapshot.tracks,
        ...(this.inspectedAudio.length ? { audio: this.inspectedAudio } : {}), ...(this.captionTracks.length ? { text: this.captionTracks, selectedTextId: this.captionId } : {}) },
        captions: this.captionTracks.length ? this.captionText : snapshot.captions,
        notice: this.value.notice, diagnostics: snapshot.diagnostics ? { ...snapshot.diagnostics, ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}) } : undefined });
    });
  }
  private async recover(generation: number, snapshot: PlayerSnapshot): Promise<void> {
    if (!this.request || generation !== this.generation) return;
    this.recovering = true;
    const request = { ...this.request, audioTrackId: snapshot.tracks.selectedAudioId ?? undefined, textTrackId: snapshot.tracks.selectedTextId, qualityId: snapshot.selectedQualityId, startAtSeconds: Math.max(0, snapshot.time.positionSeconds - (this.request.timelineOffsetSeconds ?? 0)), paused: this.pausedIntent };
    this.fallbackReason = 'Mediabunny decoding stopped; continuing the same session with HTML playback.';
    this.publish({ ...snapshot, sessionId: generation, state: 'buffering', error: null });
    this.clearSubscription(); await this.active?.dispose();
    try { await this.nextPath(request, generation); }
    catch (error) {
      if (generation === this.generation) this.publish({ ...this.value, state: 'error', error: error instanceof PlayerOperationError ? error.toFailure() : { code: 'prepare-failed', message: 'The selected source could not be played.' } });
    } finally { if (generation === this.generation) this.recovering = false; }
  }
  async play(): Promise<void> { this.pausedIntent = false; await this.requireActive().play(); }
  async pause(): Promise<void> { this.pausedIntent = true; await this.requireActive().pause(); }
  async seek(position: number): Promise<void> { await this.requireActive().seek(position); }
  async setVolume(level: number): Promise<void> { this.volume = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 1)); if (this.volume > 0) this.muted = false; await this.active?.setVolume?.(this.volume); }
  async setMuted(muted: boolean): Promise<void> { this.muted = muted; await this.active?.setMuted?.(muted); }
  async loadAudioTracks(resolveServer = true): Promise<void> {
    if (!this.request || this.request.deliveryMode !== 'direct' || !browserPlaybackPolicy().localRemux) return;
    if (this.active?.capabilities.canSelectAudioTrack) {
      await this.active.loadAudioTracks?.();
      this.inspectedAudio = this.active.snapshot.tracks.audio;
      if (resolveServer) await this.serverAudioChoices(); return;
    }
    if (this.inspectedAudio.length) return;
    if (typeof BigInt === 'undefined') { if (resolveServer) await this.serverAudioChoices(true); return; }
    const generation = this.generation;
    const { Input, UrlSource, ALL_FORMATS } = await import('mediabunny');
    if (generation !== this.generation) return;
    const input = this.audioInspector = new Input({ source: new UrlSource(this.request.url, { fetchFn: sessionMediaFetch(this.request.url), maxCacheSize: 32 * 1024 * 1024 }), formats: ALL_FORMATS });
    try {
      const video = await input.getPrimaryVideoTrack();
      if (!video) return;
      const { tracks, choices } = await audioChoices(video);
      const available = await Promise.all(tracks.map(async track => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(`audio/mp4; codecs="${await track.getCodecParameterString()}"`)));
      if (generation !== this.generation) return;
      this.inspectedAudio = choices.map((choice, index) => ({ ...choice, available: available[index] }));
      if (resolveServer) await this.serverAudioChoices();
      this.publish({ ...this.value, tracks: { ...this.value.tracks, audio: this.inspectedAudio } });
    } finally { input.dispose(); if (this.audioInspector === input) this.audioInspector = undefined; }
  }
  private async serverAudioChoices(all = false): Promise<void> {
    if (!this.request || !all && !this.inspectedAudio.some(track => !track.available)) return;
    const generation = this.generation;
    const response = await sessionMediaFetch(this.request.url)(new URL('tracks.json', this.request.url));
    const result = await response.json() as { audio?: Array<{ input_index: number; codec?: string; language?: string; title: string; selectable: boolean }> };
    if (generation !== this.generation) return;
    const unavailable = this.inspectedAudio.filter(track => !track.available);
    const server = (result.audio ?? []).filter(track => track.selectable && Number.isInteger(track.input_index) && track.input_index >= 0 && track.input_index <= 65535
      && (all || unavailable.some(local => local.codec === track.codec && (!local.language || local.language === 'und' || local.language === track.language))))
      .map(track => ({ id: `server-audio:${track.input_index}`, label: track.title, language: track.language, codec: track.codec, available: true, delivery: 'server' as const, inputIndex: track.input_index }));
    if (server.length) this.inspectedAudio = [...this.inspectedAudio.filter(track => track.available), ...server];
    this.publish({ ...this.value, tracks: { ...this.value.tracks, audio: this.inspectedAudio } });
  }
  async selectAudioTrack(id: string): Promise<void> {
    if (this.requireActive().capabilities.canSelectAudioTrack) { await this.requireActive().selectAudioTrack(id); return; }
    if (!this.inspectedAudio.some(track => track.id === id && track.available) || !this.request) throw new PlayerOperationError('unsupported-operation', 'This audio track cannot be selected locally.');
    const generation = this.generation;
    const previous = { ...this.request, startAtSeconds: this.value.time.positionSeconds - (this.request.timelineOffsetSeconds ?? 0), paused: this.value.state === 'paused' };
    this.opening = true; this.clearSubscription(); await this.active?.dispose(); this.inspectedAudio = [];
    try { this.paths = ['mse']; await this.nextPath({ ...previous, audioTrackId: id }, generation); }
    catch (cause) { if (generation === this.generation) { this.paths = ['native']; await this.nextPath(previous, generation); } throw cause; }
    finally { if (generation === this.generation) this.opening = false; }
  }
  async loadTextTracks(): Promise<void> {
    if (this.active?.snapshot.tracks.text.length) return;
    await this.captions?.discover();
    if (this.captionTracks.length) this.publish({ ...this.value, tracks: { ...this.value.tracks, text: this.captionTracks, selectedTextId: this.captionId }, captions: this.captionText });
  }
  async selectTextTrack(id: string | null): Promise<void> {
    if (this.captions && (id?.startsWith('subtitle:') || id === null && this.captionTracks.length)) {
      await this.active?.selectTextTrack(null).catch(() => undefined);
      await this.captions.select(id, this.value.time.positionSeconds); this.publish({ ...this.value, tracks: { ...this.value.tracks, text: this.captionTracks, selectedTextId: id }, captions: [] });
    } else await this.requireActive().selectTextTrack(id);
  }
  async selectQuality(id: string): Promise<void> { await this.requireActive().selectQuality?.(id); }
  async preview(position: number): Promise<Blob | null> { return await this.requireActive().preview?.(position) ?? null; }
  async stop(): Promise<void> {
    this.captions?.dispose(); this.captions = undefined;
    this.audioInspector?.dispose(); this.audioInspector = undefined;
    const generation = ++this.generation; this.cancelOpening?.(); this.cancelOpening = undefined; this.clearSubscription(); this.unsubscribe = undefined;
    const player = this.active; this.active = undefined; await player?.dispose();
    if (generation === this.generation) { this.showCanvas(false); this.publish({ ...IDLE_SNAPSHOT, sessionId: generation, state: 'stopped' }); }
  }
  async dispose(): Promise<void> { await this.stop(); this.publish({ ...this.value, state: 'disposed' }); }
  private clearSubscription(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
  private requireActive(): Player { if (!this.active) throw new PlayerOperationError('invalid-state', 'No active playback session.'); return this.active; }
  private showCanvas(show: boolean): void {
    if (this.canvas) this.canvas.style.display = show ? '' : 'none';
    if ('style' in this.media) (this.media as HTMLVideoElement).style.visibility = show ? 'hidden' : '';
  }
  private publish(snapshot: PlayerSnapshot): void { this.value = snapshot; for (const listener of this.listeners) listener(snapshot); }
}
async function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PlayerOperationError('connection-failed', 'Media preparation timed out.', undefined, 'network')), ms); })]); }
  finally { clearTimeout(timer); }
}
