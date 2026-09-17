import { VizioHtml5Adapter, VIZIO_HTML5_CAPABILITIES, type HtmlMediaLike } from './vizio-html5';
import { IDLE_SNAPSHOT, PlayerOperationError, type OpenPlayerRequest, type Player, type PlayerCapabilities, type PlayerListener, type PlayerSnapshot } from './types';

/** WebCodecs availability is a gate, never proof that the selected track decodes. */
export function mediabunnyUnavailable(canvas?: HTMLCanvasElement): string | undefined {
  if (!canvas) return 'A MediaBunny drawing surface is unavailable.';
  if (!globalThis.isSecureContext) return 'WebCodecs requires HTTPS or a trusted local context.';
  if (typeof BigInt === 'undefined' || typeof VideoDecoder === 'undefined' || typeof AudioDecoder === 'undefined' || typeof AudioContext === 'undefined')
    return 'This runtime does not expose the required WebCodecs and Web Audio APIs.';
  return undefined;
}

/** Prefer real decoded samples; failure retains the exact delivery URL and backend lease. */
export class Html5FallbackAdapter implements Player {
  readonly capabilities: PlayerCapabilities = { ...VIZIO_HTML5_CAPABILITIES, platform: 'html5', engine: 'Mediabunny preferred; native/HLS.js fallback', canSetVolume: true, limitations: ['Mediabunny requires supported WebCodecs tracks and a secure context.', 'The active engine and any local fallback are reported per playback session.'] };
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
  constructor(private readonly media: HtmlMediaLike, private readonly canvas?: HTMLCanvasElement) {}
  get snapshot(): PlayerSnapshot { return this.value; }
  subscribe(listener: PlayerListener): () => void { this.listeners.add(listener); listener(this.value); return () => this.listeners.delete(listener); }

  async open(request: OpenPlayerRequest): Promise<void> {
    const generation = ++this.generation;
    this.cancelOpening?.(); this.cancelOpening = undefined;
    this.clearSubscription(); this.unsubscribe = undefined;
    const previous = this.active; this.active = undefined; await previous?.dispose();
    if (generation !== this.generation) return;
    this.pausedIntent = request.paused ?? false;
    this.request = request; this.opening = true; this.recovering = false; this.fallbackReason = undefined;
    this.publish({ ...IDLE_SNAPSHOT, sessionId: generation, kind: request.kind, state: 'opening' });
    const unavailable = mediabunnyUnavailable(this.canvas);
    try {
      if (unavailable) { this.fallbackReason = unavailable; await this.native(request, generation); return; }
      const { MediabunnyAdapter } = await import('./mediabunny');
      if (generation !== this.generation) return;
      const player = new MediabunnyAdapter(this.canvas!);
      this.attach(player, generation, true);
      try { await withTimeout(Promise.race([player.open(request), new Promise<void>(resolve => { this.cancelOpening = resolve; })]), 15000); }
      catch {
        if (generation !== this.generation) return;
        this.fallbackReason = 'Mediabunny could not prepare this source; using the compatible HTML playback path.';
        this.clearSubscription(); await player.dispose();
        await this.native(request, generation);
      }
    } finally { if (generation === this.generation) { this.opening = false; this.cancelOpening = undefined; } }
  }
  private async native(request: OpenPlayerRequest, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const player = new VizioHtml5Adapter(this.media); this.attach(player, generation, false);
    await player.open(request);
  }
  private attach(player: Player, generation: number, bunny: boolean): void {
    this.clearSubscription(); this.active = player;
    this.showCanvas(bunny);
    void player.setVolume?.(this.volume); void player.setMuted?.(this.muted);
    this.unsubscribe = player.subscribe(snapshot => {
      if (generation !== this.generation || this.active !== player) return;
      if (bunny && snapshot.state === 'error' && !this.opening && !this.recovering) {
        void this.recover(generation, snapshot); return;
      }
      if (snapshot.state === 'idle') return;
      this.publish({ ...snapshot, sessionId: generation, diagnostics: snapshot.diagnostics ? { ...snapshot.diagnostics, ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}) } : undefined });
    });
  }
  private async recover(generation: number, snapshot: PlayerSnapshot): Promise<void> {
    if (!this.request || generation !== this.generation) return;
    this.recovering = true;
    const request = { ...this.request, startAtSeconds: Math.max(0, snapshot.time.positionSeconds - (this.request.timelineOffsetSeconds ?? 0)), paused: this.pausedIntent };
    this.fallbackReason = 'Mediabunny decoding stopped; continuing the same session with HTML playback.';
    this.publish({ ...snapshot, sessionId: generation, state: 'buffering', error: null });
    this.clearSubscription(); await this.active?.dispose();
    try { await this.native(request, generation); }
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
  async selectTextTrack(id: string | null): Promise<void> { await this.requireActive().selectTextTrack(id); }
  async stop(): Promise<void> {
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
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Decoder preparation timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
