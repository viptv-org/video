import { VizioHtml5Adapter, VIZIO_HTML5_CAPABILITIES, type HtmlMediaLike } from './vizio-html5';
import { IDLE_SNAPSHOT, PlayerOperationError, type OpenPlayerRequest, type Player, type PlayerCapabilities, type PlayerListener, type PlayerSnapshot } from './types';
import { browserPlaybackPolicy, canChangeMediaPath, mediaFailure } from './browser-policy';
import { BrowserCaptions } from './captions';

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
  get capabilities(): PlayerCapabilities { return { ...(this.active?.capabilities ?? VIZIO_HTML5_CAPABILITIES), platform: this.platform, canSetVolume: true, ...(this.captions ? { canSelectTextTrack: true, canDisableTextTrack: true } : {}) }; }
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
    this.captions?.dispose(); this.captions = undefined; this.captionTracks = []; this.captionText = []; this.captionId = null;
    if (browserPlaybackPolicy().clientInspection && request.deliveryMode === 'direct') this.captions = new BrowserCaptions(request.url, (tracks, selected, captions) => {
      this.captionTracks = tracks; this.captionId = selected; this.captionText = captions;
    });
    this.request = request; this.opening = true; this.recovering = false; this.fallbackReason = undefined;
    this.publish({ ...IDLE_SNAPSHOT, sessionId: generation, kind: request.kind, state: 'opening' });
    const unavailable = mediabunnyUnavailable(this.canvas);
    this.paths = unavailable ? ['native'] : ['bunny', 'native'];
    if (request.deliveryFormat === 'fmp4') this.paths = ['native'];
    if (browserPlaybackPolicy().localRemux && typeof MediaSource !== 'undefined' && this.media instanceof HTMLVideoElement) this.paths.push('mse');
    this.fallbackReason = unavailable;
    try {
      await this.nextPath(request, generation);
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
      this.publish({ ...snapshot, sessionId: generation, ...(this.captionTracks.length ? { tracks: { ...snapshot.tracks, text: this.captionTracks, selectedTextId: this.captionId }, captions: this.captionText } : {}), diagnostics: snapshot.diagnostics ? { ...snapshot.diagnostics, ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}) } : undefined });
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
  async selectAudioTrack(id: string): Promise<void> { await this.requireActive().selectAudioTrack(id); }
  async loadTextTracks(): Promise<void> { await this.captions?.discover(); this.publish({ ...this.value, tracks: { ...this.value.tracks, text: this.captionTracks, selectedTextId: this.captionId }, captions: this.captionText }); }
  async selectTextTrack(id: string | null): Promise<void> { if (this.captions) { await this.captions.select(id, this.value.time.positionSeconds); this.publish({ ...this.value, tracks: { ...this.value.tracks, text: this.captionTracks, selectedTextId: id }, captions: [] }); } else await this.requireActive().selectTextTrack(id); }
  async selectQuality(id: string): Promise<void> { await this.requireActive().selectQuality?.(id); }
  async preview(position: number): Promise<Blob | null> { return await this.requireActive().preview?.(position) ?? null; }
  async stop(): Promise<void> {
    this.captions?.dispose(); this.captions = undefined;
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
