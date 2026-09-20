import {
  PlayerOperationError,
  EMPTY_TRACKS,
  IDLE_SNAPSHOT,
  type PlaybackKind,
  type Player,
  type PlayerListener,
  type PlayerSnapshot,
  type PlayerState,
  type PlayerTime,
  type PlayerTracks,
  type PlayerFailure,
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
