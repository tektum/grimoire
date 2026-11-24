import { createHandshakeToken } from './handshake-token';
import { type Mapping, mapSignal, TEXTS } from './map-signal';

// The connection manager of one page: it owns the document and the provider as a pair (a session), reacts to what the server says by the table of
// `map-signal.ts`, and tells the screen what to show. It knows nothing of React, Milkdown or Hocuspocus: a session is whatever `createSession` returns.

/** What a provider tells the manager (the real provider's events, mapped by the adapter; a fake in tests). */
export type ProviderEvent =
  | { readonly type: 'status'; readonly status: 'connecting' | 'connected' | 'disconnected' }
  | { readonly type: 'authenticated'; readonly scope: 'read-write' | 'readonly' }
  | { readonly type: 'synced' }
  | { readonly type: 'authenticationFailed'; readonly reason: string }
  | { readonly type: 'close'; readonly code: number; readonly reason?: string }
  | { readonly type: 'stateless'; readonly payload: string };

export interface ProviderHandle {
  /** Starts a connection attempt. The adapter turns the provider's own retry off: attempts are the manager's. */
  connect(): void;
  disconnect(): void;
  destroy(): void;
  subscribe(listener: (event: ProviderEvent) => void): () => void;
}
export interface Session {
  readonly provider: ProviderHandle;
  /** The Y.Doc the provider syncs. */
  readonly doc: { isEmpty(): boolean; destroy(): void };
}

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface ConnectionAuth {
  getToken(): Promise<string | null>;
  refresh(): Promise<boolean>;
  signOut(reason: 'expired'): Promise<void>;
}

export interface ConnectionOptions {
  readonly auth: ConnectionAuth;
  readonly clientVersion: string;
  /** Builds a new document and provider for the page; `token` is the provider's `token` option. The provider is not connected yet. */
  readonly createSession: (token: () => Promise<string>) => Session;
  /** The Markdown of what the tab holds, taken from the live document before it is destroyed. Held in memory only. */
  readonly captureCopy?: (session: Session) => string | null;
  readonly timers?: Timers;
  readonly random?: () => number;
  /** Logs an event by name with ids and counts only: never a token, a text or a name. */
  readonly log?: (event: string, fields?: Readonly<Record<string, string | number>>) => void;
  readonly onSignOut?: () => void;
  /** A connection was made again after more than a minute without one (an outage or a hidden tab): the screen checks the minimum client version once more. */
  readonly onLongOffline?: () => void;
}

export type StopReason = 'no-access' | 'not-found' | 'reload' | 'cannot-open' | 'sign-out';

export interface ConnectionState {
  readonly phase: 'idle' | 'connecting' | 'synced' | 'retrying' | 'stopped';
  readonly stopped: StopReason | null;
  /** The text for the status line or the screen, by the table; null when there is none. */
  readonly text: string | null;
  readonly notice: string | null;
  readonly banner: string | null;
  readonly readOnly: boolean;
  /** Offline for more than ten seconds: "Offline: changes kept in this tab". */
  readonly offline: boolean;
  /** The Markdown copy of a tab that was reset, offered to the user; null otherwise. */
  readonly copy: string | null;
  /** Counts the documents of this page created so far: the screen re-mounts the editor when it changes. */
  readonly generation: number;
  /** A hidden tab let go of its connection: the editor and what it holds stay, and showing the tab connects again. */
  readonly suspended: boolean;
}

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
const JITTER = 0.5;
const OFFLINE_AFTER_MS = 10_000;
const ERROR_RETRY_MS = 30_000;
const ERROR_TRIES = 3;
const TOKEN_RETRY_MS = 5000;
const REFRESH_WINDOW_MS = 60_000;
const REFUSAL_CLOSE_WINDOW_MS = 2000;
const LONG_OFFLINE_MS = 60_000;

export class ConnectionManager {
  private readonly timers: Timers;
  private readonly random: () => number;
  private session: Session | null = null;
  private unsubscribe: (() => void) | null = null;
  private epoch: number | null = null;
  private pendingEpoch: number | null = null;
  private attempts = 0;
  private errorTries = 0;
  private retryTimer: unknown = null;
  private offlineTimer: unknown = null;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  private refusedAt = Number.NEGATIVE_INFINITY;
  /** When the connection was lost, until it is made again. */
  private lostAt: number | null = null;
  private refreshingFor: Session | null = null;
  /** The page is too large to edit (a fact about the page, not about this person): only a new document ends it. */
  private large = false;
  /** True after the manager disconnected the provider itself (a stop, or a wait before an error retry): the close that follows is its own doing and says nothing new. */
  private quiet = false;
  /** The copy taken before a close that may turn out to be a reset: offered when the next connect is refused `stale-epoch`, dropped when it is accepted. */
  private held: string | null = null;
  private current: ConnectionState = {
    phase: 'idle',
    stopped: null,
    text: null,
    notice: null,
    banner: null,
    readOnly: false,
    offline: false,
    copy: null,
    generation: 0,
    suspended: false,
  };
  private readonly listeners = new Set<(state: ConnectionState) => void>();

  constructor(private readonly options: ConnectionOptions) {
    this.timers = options.timers ?? realTimers;
    this.random = options.random ?? Math.random;
  }

  state(): ConnectionState {
    return this.current;
  }
  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  /** The session now in use (a new one after each FRESH). */
  currentSession(): Session | null {
    return this.session;
  }
  /** The state epoch recorded for the page, or null before the first sync. */
  recordedEpoch(): number | null {
    return this.epoch;
  }

  /** Creates the first session and connects. */
  start(): void {
    if (this.session !== null) return;
    this.open();
  }

  /** The user's "Try again" after the manager stopped: exactly one attempt. */
  retry(): void {
    if (this.current.phase !== 'stopped' || this.current.stopped !== 'cannot-open') return;
    this.errorTries = ERROR_TRIES; // a failure of this attempt is shown again, not retried by itself
    this.set({ phase: 'connecting', stopped: null, text: null });
    this.connectSession();
  }

  dismissCopy(): void {
    this.held = null;
    this.set({ copy: null, notice: this.current.notice === TEXTS.reset ? null : this.current.notice });
  }

  /** The tab has been hidden long enough: disconnect and stay quiet (no retries) until `resume`. Nothing happens to a manager that has stopped or not started. */
  suspend(): void {
    if (this.session === null || this.current.phase === 'stopped' || this.current.phase === 'idle' || this.current.suspended) return;
    this.clearTimers();
    this.clearOffline();
    this.quiet = true;
    this.session.provider.disconnect();
    // Only the transient text goes: the reason a page is read-only or too large stays.
    this.set({ suspended: true, phase: 'retrying', offline: false, text: this.current.text === TEXTS.offline ? null : this.current.text });
  }

  /**
   * The tab is shown again: connect again, on the same document with the recorded epoch. What the tab holds that the server never saw (typed while
   * offline) is merged; and if the page was reset meanwhile the server refuses the old epoch, which takes the stale-epoch path (the copy is offered).
   */
  resume(): void {
    if (!this.current.suspended || this.session === null) return;
    this.set({ suspended: false, phase: 'connecting' });
    this.attempts = 0;
    this.connectSession();
  }

  /** Ends the page: no more attempts, the document and the provider are destroyed. */
  stop(): void {
    this.clearTimers();
    this.teardown();
    this.set({ phase: 'idle' });
  }

  // ---- sessions ----

  private tokenFunction(): () => Promise<string> {
    return createHandshakeToken({
      getToken: () => this.options.auth.getToken(),
      clientVersion: this.options.clientVersion,
      epoch: () => this.epoch,
      timers: this.timers,
    });
  }

  private open(): void {
    const session = this.options.createSession(this.tokenFunction());
    this.session = session;
    this.unsubscribe = session.provider.subscribe((event) => this.onEvent(session, event));
    // A new document starts clean: what the old one said about access, size, offline and the banner does not carry over. A FRESH that has its own text sets it after.
    this.clearOffline();
    this.large = false;
    const carried = this.current.text;
    this.set({ generation: this.current.generation + 1, phase: 'connecting', readOnly: false, banner: null, offline: false, suspended: false, ...(carried === TEXTS.readOnly || carried === TEXTS.tooLarge || carried === TEXTS.offline ? { text: null } : {}) });
    this.connectSession();
  }

  /** Connects the current session; a tab that holds a document but never learned the page's epoch first starts over (it could push stale content). */
  private connectSession(): void {
    const session = this.session;
    if (session === null || this.current.suspended) return; // a hidden tab stays disconnected, whatever was waiting to connect it

    if (this.epoch === null && !session.doc.isEmpty()) {
      this.fresh();
      return;
    }
    this.attempts += 1;
    this.quiet = false;
    session.provider.connect();
  }

  private teardown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const session = this.session;
    this.session = null;
    session?.provider.destroy();
    session?.doc.destroy();
  }

  /** FRESH: a new document and provider for the same page, the old ones never reconnected. The copy is taken first, from the live document. */
  private fresh(options: { readonly capture?: boolean } = {}): void {
    const session = this.session;
    if (session !== null && options.capture === true && this.held === null) this.held = this.options.captureCopy?.(session) ?? null;
    this.clearTimers();
    this.teardown();
    this.pendingEpoch = null;
    this.attempts = 0;
    this.open();
  }

  // ---- events ----

  private onEvent(from: Session, event: ProviderEvent): void {
    if (from !== this.session) return; // an old session says nothing: its provider is destroyed
    if (this.quiet && (event.type === 'close' || event.type === 'authenticationFailed')) return;
    switch (event.type) {
      case 'status':
        this.onStatus(event.status);
        return;
      case 'authenticated':
        if (event.scope !== 'readonly') {
          // Signed in with the right to write: the read-only state of an earlier connection (a reader who was upgraded) ends here.
          this.set({ readOnly: this.large, text: this.current.text === TEXTS.readOnly ? null : this.current.text });
          return;
        }
        this.act(mapSignal({ type: 'scope', readOnly: true }));
        return;
      case 'synced':
        this.onSynced();
        return;
      case 'authenticationFailed': {
        const mapping = mapSignal({ type: 'authenticationFailed', reason: event.reason });
        if (mapping.behaviour === 'REFRESH') this.refusedAt = this.timers.now();
        this.act(mapping);
        return;
      }
      case 'close': {
        const mapping = mapSignal({ type: 'close', code: event.code, ...(event.reason === undefined ? {} : { reason: event.reason }) });
        // The server closes the socket a moment after it refused the token: that close is the same event, not a second refusal.
        if (mapping.behaviour === 'REFRESH' && this.timers.now() - this.refusedAt < REFUSAL_CLOSE_WINDOW_MS) return;
        // The close of our own disconnect while the token is being refreshed is a plain drop: the refresh reconnects, so no retry of its own. A close that says more (access changed, a reset) still counts.
        if (this.refreshingFor === from && (mapping.behaviour === 'RETRY' || mapping.behaviour === 'BUSY')) return;
        this.act(mapping);
        return;
      }
      case 'stateless':
        this.act(mapSignal({ type: 'stateless', payload: event.payload }));
        return;
    }
  }

  private onStatus(status: 'connecting' | 'connected' | 'disconnected'): void {
    if (this.current.suspended) return; // the disconnect of a hidden tab is not an outage
    if (status === 'disconnected' && this.lostAt === null) this.lostAt = this.timers.now();
    if (status === 'disconnected') {
      if (this.offlineTimer === null && this.current.phase !== 'stopped') this.offlineTimer = this.timers.setTimeout(() => this.set({ offline: true, text: TEXTS.offline }), OFFLINE_AFTER_MS);
      return;
    }
    if (status === 'connected') this.clearOffline();
  }

  private onSynced(): void {
    // The epoch arrives with the connection; it is recorded only once the page has synced, so a connection that drops first leaves it unrecorded.
    if (this.pendingEpoch !== null) this.epoch = this.pendingEpoch;
    this.attempts = 0;
    this.errorTries = 0;
    if (this.lostAt !== null && this.timers.now() - this.lostAt > LONG_OFFLINE_MS) this.options.onLongOffline?.();
    this.lostAt = null;
    this.held = null; // accepted: the copy is not needed and no reference to it remains
    this.clearOffline();
    // The reset notice stays while the copy it speaks of is offered: it is the reason the copy is there.
    const keep = this.current.readOnly && (this.current.text === TEXTS.readOnly || this.current.text === TEXTS.tooLarge); // the label of a read-only page outlives the sync
    this.set({ phase: 'synced', text: keep ? this.current.text : null, notice: this.current.copy !== null ? this.current.notice : null });
  }

  // ---- behaviours ----

  private act(mapping: Mapping): void {
    if (mapping.log !== undefined) this.options.log?.(mapping.log);
    switch (mapping.behaviour) {
      case 'EPOCH':
        this.pendingEpoch = mapping.epoch ?? null;
        return;
      case 'IGNORE':
      case 'LOG':
        return;
      case 'NOTICE':
        this.set({ notice: mapping.text ?? null });
        return;
      case 'BANNER':
        this.set({ banner: mapping.text ?? null });
        return;
      case 'READ_ONLY':
        this.set({ readOnly: true, text: mapping.text ?? null });
        return;
      case 'LARGE':
        this.large = true;
        this.set({ readOnly: true, text: mapping.text ?? null });
        return;
      case 'RETRY':
      case 'BUSY':
        this.scheduleRetry(mapping);
        return;
      case 'TOKEN':
        this.set({ phase: 'retrying', text: mapping.text ?? null });
        this.later(TOKEN_RETRY_MS, () => this.connectSession());
        return;
      case 'ERROR':
        this.onError(mapping);
        return;
      case 'REFRESH':
        void this.refreshThenRetry();
        return;
      case 'SIGN_OUT':
        void this.signOut();
        return;
      case 'NO_ACCESS':
        this.stopWith('no-access', mapping.text ?? null);
        return;
      case 'NOT_FOUND':
        this.stopWith('not-found', null);
        return;
      case 'RELOAD':
        this.stopWith('reload', mapping.text ?? null);
        return;
      case 'FRESH':
        this.onFresh(mapping);
        return;
    }
  }

  /** RETRY: keep the document, reconnect after a growing delay (1 s, doubling, at most 30 s, jittered), never sooner than the row's minimum. */
  private scheduleRetry(mapping: Mapping): void {
    this.lostAt ??= this.timers.now();
    this.clearRetry();
    const base = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, this.attempts - 1));
    const jittered = base * (1 + (this.random() * 2 - 1) * JITTER);
    const delay = Math.max(mapping.minDelayMs ?? 0, Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, jittered)));
    this.set({ phase: 'retrying', text: mapping.text ?? this.current.text });
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      this.connectSession();
    }, delay);
  }

  private later(ms: number, fn: () => void): void {
    this.clearRetry();
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      fn();
    }, ms);
  }

  private onError(mapping: Mapping): void {
    this.quiet = true;
    this.session?.provider.disconnect();
    if (mapping.noRetry === true || this.errorTries >= ERROR_TRIES) {
      this.stopWith('cannot-open', mapping.text ?? null);
      return;
    }
    this.errorTries += 1;
    this.set({ phase: 'retrying', text: mapping.text ?? null });
    this.later(ERROR_RETRY_MS, () => this.connectSession());
  }

  private async refreshThenRetry(): Promise<void> {
    if (this.refreshingFor !== null && this.refreshingFor === this.session) return; // one refresh per session at a time: a second signal for the same cause arrives while it runs
    const now = this.timers.now();
    if (now - this.lastRefreshAt < REFRESH_WINDOW_MS) {
      await this.signOut();
      return;
    }
    this.lastRefreshAt = now;
    const session = this.session;
    session?.provider.disconnect();
    this.refreshingFor = session;
    const refreshed = await this.options.auth.refresh().catch(() => false);
    if (this.refreshingFor === session) this.refreshingFor = null;
    // The page may have been stopped, or its session replaced, while the refresh ran: then it is not this one's to reconnect.
    if (this.session === null || this.session !== session || this.current.phase === 'stopped') return;
    if (!refreshed) {
      await this.signOut();
      return;
    }
    this.connectSession();
  }

  private async signOut(): Promise<void> {
    this.stopWith('sign-out', null);
    await this.options.auth.signOut('expired');
    this.options.onSignOut?.();
  }

  private stopWith(reason: StopReason, text: string | null): void {
    this.clearTimers();
    this.quiet = true;
    this.session?.provider.disconnect();
    this.set({ phase: 'stopped', stopped: reason, text });
  }

  private onFresh(mapping: Mapping): void {
    if (mapping.offerCopy === true) {
      // The page was reset (or the server holds an older state): the copy is offered, the recorded epoch is dropped, and the page reopens from the server.
      const copy = this.held ?? (this.session === null ? null : (this.options.captureCopy?.(this.session) ?? null));
      this.epoch = null;
      this.held = null;
      this.fresh();
      this.set({ copy: copy === null || copy === '' ? null : copy, notice: mapping.text ?? null });
      return;
    }
    // Access changed or a malformed update: a new document; the copy is held, not offered, until the next connect says whether the page was reset.
    this.fresh({ capture: true });
    if (mapping.text !== undefined) this.set({ text: mapping.text });
  }

  // ---- state ----

  private clearRetry(): void {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
  private clearOffline(): void {
    if (this.offlineTimer !== null) this.timers.clearTimeout(this.offlineTimer);
    this.offlineTimer = null;
    if (this.current.offline) this.set({ offline: false, text: null });
  }
  private clearTimers(): void {
    this.clearRetry();
    if (this.offlineTimer !== null) this.timers.clearTimeout(this.offlineTimer);
    this.offlineTimer = null;
  }

  private set(patch: Partial<ConnectionState>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of [...this.listeners]) listener(this.current);
  }
}
