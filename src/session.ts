import {
  PlayerOperationError,
  EMPTY_TRACKS,
  IDLE_SNAPSHOT,
  type PlaybackBackendError,
  type PlaybackCapabilities,
  type PlaybackKind,
  type PlaybackSessionView,
  type PlaybackStart,
  type Player,
  type PlayerFailure,
  type PlayerListener,
  type PlayerSnapshot,
  type PlayerState,
  type PlayerTime,
  type PlayerTracks,
} from './types';

/** Internal session gate: adapters call `isCurrent` from every async callback. */
export abstract class SessionPlayer implements Player {
  abstract readonly capabilities: Player['capabilities'];

  private listeners = new Set<PlayerListener>();
  private currentSession = 0;
  private nextSession = 0;
  private currentSnapshot: PlayerSnapshot = IDLE_SNAPSHOT;

  get snapshot(): PlayerSnapshot {
    return this.currentSnapshot;
  }

  subscribe(listener: PlayerListener): () => void {
    this.listeners.add(listener);
    listener(this.currentSnapshot);
    return () => this.listeners.delete(listener);
  }

  protected startSession(kind: PlaybackKind): number {
    const sessionId = ++this.nextSession;
    this.currentSession = sessionId;
    this.publish({
      sessionId,
      state: 'opening',
      kind,
      time: { positionSeconds: 0, durationSeconds: null },
      tracks: EMPTY_TRACKS,
      error: null,
    });
    return sessionId;
  }

  protected isCurrent(sessionId: number): boolean {
    return this.currentSession === sessionId;
  }

  /** An operation outside a live session is a programming error, not a failure. */
  protected activeSessionOrThrow(): number {
    if (this.snapshot.sessionId === 0 || !this.isCurrent(this.snapshot.sessionId)) {
      throw new PlayerOperationError('invalid-state', 'No active playback session.');
    }
    return this.snapshot.sessionId;
  }

  /** Makes every previous callback inert. */
  protected invalidateSession(): void {
    this.currentSession = 0;
  }

  protected update(sessionId: number, patch: {
    diagnostics?: PlayerSnapshot['diagnostics'];
    volume?: PlayerSnapshot['volume'];
    state?: PlayerState;
    time?: PlayerTime;
    tracks?: PlayerTracks;
    error?: PlayerFailure | null;
  }): void {
    if (!this.isCurrent(sessionId)) return;
    this.publish({ ...this.currentSnapshot, ...patch });
  }

  protected terminal(state: Extract<PlayerState, 'stopped' | 'disposed'>): void {
    const sessionId = ++this.nextSession;
    this.currentSession = 0;
    this.publish({
      sessionId,
      state,
      kind: null,
      time: { positionSeconds: 0, durationSeconds: null },
      tracks: EMPTY_TRACKS,
      error: null,
    });
  }

  protected fail(sessionId: number, error: PlayerFailure): void {
    this.update(sessionId, { state: 'error', error });
  }

  private publish(snapshot: PlayerSnapshot): void {
    this.currentSnapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  abstract open(request: Parameters<Player['open']>[0]): Promise<void>;
  abstract play(): Promise<void>;
  abstract pause(): Promise<void>;
  abstract seek(positionSeconds: number): Promise<void>;
  abstract stop(): Promise<void>;
  abstract dispose(): Promise<void>;
  abstract selectAudioTrack(trackId: string): Promise<void>;
  abstract selectTextTrack(trackId: string | null): Promise<void>;
}

/**
 * The catalog identity the controller needs to start playback. Applications
 * bind their own richer item and source types through the generic parameters.
 */
export interface PlaybackIntentItem {
  readonly id: string;
  readonly type: string;
}
export interface PlaybackIntentSource {
  readonly id: string;
}

/** A source is always explicit for ordinary VOD and Resume flows. */
export interface SessionStartIntent<
  Item extends PlaybackIntentItem = PlaybackIntentItem,
  Source extends PlaybackIntentSource = PlaybackIntentSource,
> {
  readonly item: Item;
  readonly source?: Source;
  readonly position?: number;
}

export interface TrackReplacement {
  readonly audioTrackIndex?: number;
  readonly subtitleTrackIndex?: number;
  readonly subtitlesOff?: boolean;
}

export interface PlaybackControllerActive<
  Item extends PlaybackIntentItem = PlaybackIntentItem,
  Source extends PlaybackIntentSource = PlaybackIntentSource,
> {
  readonly intent: SessionStartIntent<Item, Source>;
  readonly session: PlaybackSessionView;
  readonly request: PlaybackStart;
}

export type PlaybackControllerState = 'idle' | 'opening' | 'playing' | 'replacing' | 'preparing-next' | 'stopped' | 'error';

export interface PlaybackControllerSnapshot<
  Item extends PlaybackIntentItem = PlaybackIntentItem,
  Source extends PlaybackIntentSource = PlaybackIntentSource,
> {
  readonly state: PlaybackControllerState;
  readonly active: PlaybackControllerActive<Item, Source> | null;
  readonly error: Error | null;
}

export type PlaybackControllerListener<
  Item extends PlaybackIntentItem = PlaybackIntentItem,
  Source extends PlaybackIntentSource = PlaybackIntentSource,
> = (snapshot: PlaybackControllerSnapshot<Item, Source>) => void;

/**
 * The server playback port this controller coordinates. The application binds
 * its own API client; startPlayback rejections are `Error`s carrying an
 * HTTP-like `status` where 0 means transport failure.
 */
export interface PlaybackBackend {
  startPlayback(request: PlaybackStart): Promise<PlaybackSessionView>;
  stopPlayback(sessionId: string): Promise<void>;
}

export interface PlaybackSessionControllerOptions {
  readonly player: Player;
  readonly backend: PlaybackBackend;
  readonly capabilities: PlaybackCapabilities | (() => Promise<PlaybackCapabilities>);
}

/**
 * Coordinates the server's opaque playback session with one device adapter.
 * It never discovers or ranks a replacement source. On managed seeks/tracks it
 * starts one replacement for the same selected source and restores the old
 * session if the device cannot open the candidate.
 */
export class PlaybackSessionController<
  Item extends PlaybackIntentItem = PlaybackIntentItem,
  Source extends PlaybackIntentSource = PlaybackIntentSource,
> {
  private readonly listeners = new Set<PlaybackControllerListener<Item, Source>>();
  private current: PlaybackControllerActive<Item, Source> | null = null;
  private nextGeneration = 0;
  private operationGeneration = 0;
  private activePlayerSessionId = 0;
  private pausedPlayerSessionId = 0;
  private readonly recoveredSessions = new Set<string>();
  /** The one next-operation Back is allowed to restore after adapter open. */
  private restoreRequestedOperation: number | null = null;
  private currentSnapshot: PlaybackControllerSnapshot<Item, Source> = { state: 'idle', active: null, error: null };

  constructor(private readonly options: PlaybackSessionControllerOptions) {}

  get snapshot(): PlaybackControllerSnapshot<Item, Source> {
    return this.currentSnapshot;
  }

  subscribe(listener: PlaybackControllerListener<Item, Source>): () => void {
    this.listeners.add(listener);
    listener(this.currentSnapshot);
    return () => this.listeners.delete(listener);
  }

  async start(intent: SessionStartIntent<Item, Source>): Promise<PlaybackControllerActive<Item, Source>> {
    this.recoveredSessions.clear();
    this.cancelNext(false);
    const operation = ++this.operationGeneration;
    this.publish({ state: this.current ? 'replacing' : 'opening', active: this.current, error: null });
    try {
      const capabilities = await this.resolveCapabilities();
      if (operation !== this.operationGeneration) return this.cancelledResult();
      let request = playbackRequest(intent, capabilities, intent.position ?? 0);
      // Delivery refusals (406) and network failures escalate the same selected
      // source through the shared delivery ladder before giving up, so one
      // transport or inspection refusal cannot strand a source the server can
      // still deliver.
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await this.transition(intent, request, this.current, () => operation === this.operationGeneration);
        } catch (error) {
          if (operation !== this.operationGeneration) return this.cancelledResult();
          // A direct-URL client never accepts managed delivery; a refusal
          // surfaces instead of escalating up the delivery ladder.
          const escalated = request.capabilities.directUrls !== true && attempt < 2
            ? escalatePreparation(request, error)
            : undefined;
          if (!escalated) throw error;
          request = escalated;
        }
      }
    } catch (error) {
      if (operation !== this.operationGeneration) return this.cancelledResult();
      this.publish({ state: this.current ? 'playing' : 'error', active: this.current,
        error: error instanceof Error ? error : new Error(String(error)) });
      throw error;
    }
  }

  /** Observe the actual adapter snapshot, including decoder failures after open. */
  async recoverPlayback(snapshot: PlayerSnapshot): Promise<boolean> {
    if (snapshot.sessionId !== this.options.player.snapshot.sessionId) return true;
    if (snapshot.state === 'paused') this.pausedPlayerSessionId = snapshot.sessionId;
    else if (snapshot.state === 'playing') this.pausedPlayerSessionId = 0;
    if (!snapshot.error) return false;
    // Preparation already owns adapter failures and the bounded initial retry.
    if (['opening', 'replacing', 'preparing-next'].includes(this.currentSnapshot.state)) return true;
    const active = this.current;
    if (!active || snapshot.sessionId !== this.activePlayerSessionId) return true;
    // A direct-URL client never escalates to managed delivery; the decoder
    // failure surfaces honestly instead.
    if (active.request.capabilities.directUrls) return false;
    const request = recoveryRequest(active.session, active.request, snapshot.error.code);
    if (!request || this.recoveredSessions.has(active.session.id)) return false;
    this.recoveredSessions.add(active.session.id);
    this.cancelNext(false);
    const operation = ++this.operationGeneration;
    const position = active.intent.item.type === 'live' ? 0 : snapshot.time.positionSeconds;
    const paused = this.pausedPlayerSessionId === snapshot.sessionId;
    await this.transition({ ...active.intent, position }, { ...request, position }, active,
      () => operation === this.operationGeneration, () => false, { position, paused });
    return true;
  }

  async seek(position: number): Promise<void> {
    this.cancelNext(false);
    const operation = ++this.operationGeneration;
    const active = this.requireActive();
    if (!Number.isFinite(position) || position < 0) throw new Error('Seek position must be a non-negative number.');
    if (active.session.mode === 'direct') {
      await this.options.player.seek(position);
      return;
    }
    const request = { ...active.request, position };
    await this.transition({ ...active.intent, position }, request, active, () => operation === this.operationGeneration);
  }

  /**
   * Repeated seeks: a replacement that is superseded before it starts is
   * abandoned at once instead of finishing a second managed session. Every
   * started session holds provider capacity, so rapid presses would otherwise
   * exhaust the provider's connection budget and be refused with 429.
   */
  async seekFrom(
    resolvePosition: () => number,
    currentPosition: () => number,
  ): Promise<void> {
    this.cancelNext(false);
    const operation = ++this.operationGeneration;
    const active = this.requireActive();
    if (active.session.mode === 'direct') {
      await this.options.player.seek(resolvePosition());
      return;
    }
    const position = resolvePosition();
    if (!Number.isFinite(position) || position < 0) throw new Error('Seek position must be a non-negative number.');
    // Read the live position after this operation still owns the controller;
    // startPlayback is the first await, so the read is neither stale nor racy.
    const stillWanted = () => operation === this.operationGeneration;
    const request = { ...active.request, position };
    await this.transition(
      { ...active.intent, position },
      request,
      active,
      stillWanted,
      () => stillWanted(),
      { position: currentPosition(), paused: this.options.player.snapshot.state === 'paused' },
    );
  }

  async replaceTracks(selection: TrackReplacement): Promise<void> {
    this.cancelNext(false);
    const operation = ++this.operationGeneration;
    const active = this.requireActive();
    const position = this.options.player.snapshot.time.positionSeconds;
    const request: PlaybackStart = { ...active.request, position, ...selection };
    await this.transition({ ...active.intent, position }, request, active, () => operation === this.operationGeneration);
  }

  /**
   * The resolver is supplied by the UI/backend continuation flow. It must
   * provide the bounded next source already chosen by that flow; this module
   * never falls through to a different provider.
   */
  async prepareNext(resolveNext: () => Promise<SessionStartIntent<Item, Source> | null>): Promise<void> {
    const active = this.requireActive();
    const generation = ++this.nextGeneration;
    const operation = ++this.operationGeneration;
    this.restoreRequestedOperation = null;
    this.publish({ state: 'preparing-next', active, error: null });
    try {
      const next = await resolveNext();
      if (generation !== this.nextGeneration) return;
      if (!next) {
        this.publish({ state: playerState(this.options.player), active: this.current, error: null });
        return;
      }
      const capabilities = await this.resolveCapabilities();
      if (generation !== this.nextGeneration || operation !== this.operationGeneration) return;
      const request = playbackRequest(next, capabilities, next.position ?? 0);
      await this.transition(
        next,
        request,
        active,
        () => generation === this.nextGeneration && operation === this.operationGeneration,
        () => this.restoreRequestedOperation === operation,
      );
    } catch (cause) {
      if (generation !== this.nextGeneration) return;
      const error = asError(cause);
      this.publish({ state: 'error', active: this.current, error });
      throw error;
    } finally {
      if (this.restoreRequestedOperation === operation) this.restoreRequestedOperation = null;
    }
  }

  /**
   * Back requests restoration if AVPlay/HTML media has already switched to a
   * next candidate. Internal replacement and stop callers pass false: their
   * newer operation owns the adapter and an old operation must stay inert.
   */
  cancelNext(restoreOutgoing = true): void {
    if (!restoreOutgoing) this.restoreRequestedOperation = null;
    else if (this.currentSnapshot.state === 'preparing-next' || this.currentSnapshot.state === 'replacing') {
      this.restoreRequestedOperation = this.operationGeneration;
    }
    this.nextGeneration += 1;
    if (this.currentSnapshot.state === 'preparing-next' || this.currentSnapshot.state === 'replacing') {
      this.operationGeneration += 1;
      this.publish({ state: playerState(this.options.player), active: this.current, error: null });
    }
  }

  async stop(): Promise<void> {
    this.recoveredSessions.clear();
    this.cancelNext(false);
    this.operationGeneration += 1;
    const active = this.current;
    this.current = null;
    await this.options.player.stop();
    if (active) await this.options.backend.stopPlayback(active.session.id);
    this.publish({ state: 'stopped', active: null, error: null });
  }

  private async transition(
    intent: SessionStartIntent<Item, Source>,
    request: PlaybackStart,
    previous: PlaybackControllerActive<Item, Source> | null,
    stillWanted: () => boolean = () => true,
    restoreOnCancellation: () => boolean = () => false,
    previousState?: { position: number; paused: boolean },
  ): Promise<PlaybackControllerActive<Item, Source>> {
    const wasPaused = previousState?.paused ?? this.options.player.snapshot.state === 'paused';
    const previousPosition = previousState?.position ?? this.options.player.snapshot.time.positionSeconds;
    this.publish({ state: previous ? 'replacing' : 'opening', active: previous, error: null });
    let session: PlaybackSessionView;
    try {
      session = await this.options.backend.startPlayback(request);
    } catch (cause) {
      if (!stillWanted()) return this.cancelledResult();
      const error = asError(cause);
      this.publish({ state: 'error', active: this.current, error });
      throw error;
    }
    if (!stillWanted()) {
      await this.options.backend.stopPlayback(session.id);
      return this.cancelledResult();
    }
    try {
      for (;;) {
        try {
          await this.options.player.open(adapterRequest(session, itemKind(intent.item), request.position ?? 0, wasPaused));
          break;
        } catch (cause) {
          // A direct-URL client never escalates an open failure into managed
          // delivery; the adapter error surfaces instead.
          const recovery = cause instanceof PlayerOperationError && request.capabilities.directUrls !== true
            ? recoveryRequest(session, request, cause.code)
            : undefined;
          if (!stillWanted() || !recovery) throw cause;
          await this.options.backend.stopPlayback(session.id);
          if (!stillWanted()) throw new DOMException('Playback operation was cancelled.', 'AbortError');
          request = recovery;
          session = await this.options.backend.startPlayback(request);
          if (!stillWanted()) throw new DOMException('Playback operation was cancelled.', 'AbortError');
        }
      }
      const candidate: PlaybackControllerActive<Item, Source> = { intent, request, session };
      if (!stillWanted()) {
        await this.options.backend.stopPlayback(session.id);
        if (restoreOnCancellation()) {
          await this.restore(previous, previousPosition, wasPaused, restoreOnCancellation);
        }
        return this.cancelledResult();
      }
      this.current = candidate;
      this.activePlayerSessionId = this.options.player.snapshot.sessionId;
      // A cleanup failure leaks a backend session but must never undo a
      // candidate already proven playable on the device.
      if (previous) await this.options.backend.stopPlayback(previous.session.id).catch(() => undefined);
      this.publish({ state: playerState(this.options.player), active: candidate, error: null });
      return candidate;
    } catch (cause) {
      const error = asError(cause);
      // `session` is undefined only when the backend answered with no session
      // and the original failure already propagated; do not mask it with a
      // TypeError while trying to clean up.
      if (session!) await this.options.backend.stopPlayback(session!.id).catch(() => undefined);
      const shouldRestore = () => stillWanted() || restoreOnCancellation();
      if (shouldRestore()) {
        try {
          await this.restore(previous, previousPosition, wasPaused, shouldRestore);
        } catch {
          this.current = null;
          await this.options.player.stop().catch(() => undefined);
          if (previous) await this.options.backend.stopPlayback(previous.session.id).catch(() => undefined);
        }
      }
      if (!stillWanted()) return this.cancelledResult();
      this.publish({ state: 'error', active: this.current, error });
      throw error;
    }
  }

  private async restore(
    previous: PlaybackControllerActive<Item, Source> | null,
    position: number,
    paused: boolean,
    stillRestore: () => boolean = () => true,
  ): Promise<void> {
    if (!previous) {
      this.current = null;
      return;
    }
    if (!stillRestore()) return;
    await this.options.player.open(adapterRequest(previous.session, itemKind(previous.intent.item), position, paused));
    if (!stillRestore()) return;
    this.current = previous;
    this.activePlayerSessionId = this.options.player.snapshot.sessionId;
    this.publish({ state: playerState(this.options.player), active: previous, error: null });
  }

  /** An invalidated UI operation either yields the current owner or AbortError. */
  private cancelledResult(): PlaybackControllerActive<Item, Source> {
    if (this.current) {
      this.publish({ state: playerState(this.options.player), active: this.current, error: null });
      return this.current;
    }
    throw new DOMException('Playback operation was cancelled.', 'AbortError');
  }

  private async resolveCapabilities(): Promise<PlaybackCapabilities> {
    return typeof this.options.capabilities === 'function'
      ? this.options.capabilities() : this.options.capabilities;
  }

  private requireActive(): PlaybackControllerActive<Item, Source> {
    if (!this.current) throw new Error('No active playback session.');
    return this.current;
  }

  private publish(snapshot: PlaybackControllerSnapshot<Item, Source>): void {
    this.currentSnapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

function playbackRequest(intent: SessionStartIntent, capabilities: PlaybackCapabilities, position: number): PlaybackStart {
  if (intent.item.type === 'live') return { channelId: intent.item.id, position, capabilities };
  if (!intent.source) throw new Error('VOD playback requires an explicit source.');
  return { streamId: intent.source.id, position, capabilities };
}

function adapterRequest(session: PlaybackSessionView, kind: PlaybackKind, position: number, paused: boolean): Parameters<Player['open']>[0] {
  const direct = session.mode === 'direct';
  const deliveryStart = direct ? 0 : Math.max(0, session.position);
  return {
    url: session.url,
    kind,
    startAtSeconds: direct ? position : Math.max(0, position - deliveryStart),
    timelineOffsetSeconds: deliveryStart,
    // A managed delivery is a rolling window; only the session knows how long
    // the title is. Direct original files may refine it with their own length.
    timelineDurationSeconds: kind === 'live' || !(session.duration > 0) ? undefined : session.duration,
    adoptEngineDuration: direct,
    deliveryMode: direct ? 'direct' : 'managed',
    deliveryFormat: session.format,
    paused,
    authorization: session.authorization,
  };
}

function itemKind(item: PlaybackIntentItem): PlaybackKind {
  return item.type === 'live' ? 'live' : 'vod';
}

function playerState(player: Player): Extract<PlaybackControllerState, 'playing' | 'opening' | 'error'> {
  return player.snapshot.state === 'paused' ? 'playing' : player.snapshot.state === 'error' ? 'error' : 'playing';
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error('Playback operation failed.');
}

/** The playback port reports refusals as Errors carrying an HTTP-like status. */
function refusalStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const { status } = error as Partial<PlaybackBackendError>;
  return typeof status === 'number' ? status : undefined;
}

/**
 * A delivery refusal is answered with the next delivery rung for the same
 * source: original delivery, then managed output, then a forced transcode.
 * Only a network failure (0) or the server's delivery refusal (406) escalates;
 * validation (400) and every other answer keeps its own meaning.
 */
function escalatePreparation(request: PlaybackStart, error: unknown): PlaybackStart | undefined {
  const status = refusalStatus(error);
  if (status !== 0 && status !== 406) return undefined;
  if (!request.managedOnly) return { ...request, managedOnly: true };
  if (!request.forceTranscode) return { ...request, managedOnly: true, forceTranscode: true };
  return undefined;
}

/** Keep the selected source while escalating only after the cheaper rung fails. */
function recoveryRequest(
  session: PlaybackSessionView,
  request: PlaybackStart,
  code: PlayerFailure['code'],
): PlaybackStart | undefined {
  if (code !== 'unsupported-format') return undefined;
  if (session.mode === 'direct' && !request.managedOnly)
    return { ...request, managedOnly: true };
  if (session.mode !== 'direct' && !request.forceTranscode)
    return { ...request, managedOnly: true, forceTranscode: true };
  return undefined;
}
