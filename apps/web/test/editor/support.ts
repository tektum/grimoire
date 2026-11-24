import type { ConnectionAuth, ProviderEvent, ProviderHandle, Session, Timers } from '../../src/editor/core/connection';

/** A clock the test moves by hand: timers run in order of their time, and `advance` runs those that fall due. */
export class FakeClock implements Timers {
  private at = 1_000_000;
  private nextId = 1;
  private readonly pending = new Map<number, { when: number; fn: () => void }>();
  now(): number {
    return this.at;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    return this.schedule(fn, ms);
  }
  private schedule(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.pending.set(id, { when: this.at + Math.max(0, ms), fn });
    return id;
  }
  /** The same as `setTimeout`, under a name of its own for a test that wants a delayed answer on this clock. */
  after(fn: () => void, ms: number): unknown {
    return this.schedule(fn, ms);
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  pendingCount(): number {
    return this.pending.size;
  }
  /** The wait until the next timer, or null. */
  nextIn(): number | null {
    const times = [...this.pending.values()].map((t) => t.when - this.at);
    return times.length === 0 ? null : Math.min(...times);
  }
  async advance(ms: number): Promise<void> {
    const end = this.at + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.when <= end).sort((a, b) => a[1].when - b[1].when)[0];
      if (due === undefined) break;
      this.pending.delete(due[0]);
      this.at = Math.max(this.at, due[1].when);
      due[1].fn();
      await flush();
    }
    this.at = end;
    await flush();
  }
}

/** Lets promise callbacks run. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

export class FakeDoc {
  destroyed = false;
  constructor(public text = '') {}
  isEmpty(): boolean {
    return this.text === '';
  }
  destroy(): void {
    this.destroyed = true;
  }
}

/** A provider the test drives: it records what the manager asks and says what the test tells it to say. */
export class FakeProvider implements ProviderHandle {
  connects = 0;
  disconnects = 0;
  destroyed = false;
  /** Every token the manager's token function produced, one per connect (a rejection is kept as the text of the error). */
  tokens: string[] = [];
  failures: string[] = [];
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  /** A provider that keeps talking after it was unsubscribed and destroyed (a real one can have an event already on its way). */
  leaky = false;
  constructor(
    readonly token: () => Promise<string>,
    private readonly clock: FakeClock,
  ) {}
  connect(): void {
    this.connects += 1;
    // Like the real provider: the token function is asked on connect, and a failure is an authenticationFailed with the provider's own text.
    void this.token().then(
      (t) => void this.tokens.push(t),
      (e: unknown) => {
        const reason = `Failed to get token during sendToken(): ${String(e)}`;
        this.failures.push(reason);
        this.emit({ type: 'authenticationFailed', reason });
      },
    );
  }
  disconnect(): void {
    this.disconnects += 1;
  }
  destroy(): void {
    this.destroyed = true;
    if (!this.leaky) this.listeners.clear();
  }
  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void (this.leaky ? undefined : this.listeners.delete(listener));
  }
  emit(event: ProviderEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  /** What a connect that works looks like to the manager: connected, the epoch message, then synced. */
  succeed(epoch: number | null = 3): void {
    this.emit({ type: 'status', status: 'connected' });
    this.emit({ type: 'authenticated', scope: 'read-write' });
    if (epoch !== null) this.emit({ type: 'stateless', payload: JSON.stringify({ grimoire: 1, kind: 'epoch', epoch }) });
    this.emit({ type: 'synced' });
  }
  refuse(reason: string): void {
    this.emit({ type: 'authenticationFailed', reason });
  }
  close(code: number, reason?: string): void {
    this.emit({ type: 'close', code, ...(reason === undefined ? {} : { reason }) });
  }
  stateless(message: Record<string, unknown>): void {
    this.emit({ type: 'stateless', payload: JSON.stringify({ grimoire: 1, ...message }) });
  }
  disconnected(): void {
    this.emit({ type: 'status', status: 'disconnected' });
  }
  get clockNow(): number {
    return this.clock.now();
  }
}

export interface Harness {
  clock: FakeClock;
  sessions: { provider: FakeProvider; doc: FakeDoc }[];
  auth: ConnectionAuth & { refreshes: number; signOuts: string[]; refreshResult: boolean; token: string | null };
  /** The latest session. */
  last(): { provider: FakeProvider; doc: FakeDoc };
  options: {
    auth: ConnectionAuth;
    clientVersion: string;
    createSession: (token: () => Promise<string>) => Session;
    timers: FakeClock;
    random: () => number;
    captureCopy: (s: Session) => string | null;
    log: (e: string) => void;
  };
  logs: string[];
}

/** Everything a manager needs, with fakes: the sessions it creates are kept, in order, for the test to drive. */
export function harness(over: { docText?: string; random?: number } = {}): Harness {
  const clock = new FakeClock();
  const sessions: Harness['sessions'] = [];
  const logs: string[] = [];
  const auth: Harness['auth'] = {
    refreshes: 0,
    signOuts: [],
    refreshResult: true,
    token: 'session-token',
    getToken: async () => auth.token,
    refresh: async () => {
      auth.refreshes += 1;
      return auth.refreshResult;
    },
    signOut: async (reason) => void auth.signOuts.push(reason),
  };
  const options: Harness['options'] = {
    auth,
    clientVersion: '0.0.0',
    timers: clock,
    random: () => over.random ?? 0.5, // 0.5 is no jitter: the delay is the base
    log: (e) => void logs.push(e),
    createSession: (token) => {
      const session = { provider: new FakeProvider(token, clock), doc: new FakeDoc(sessions.length === 0 ? (over.docText ?? '') : '') };
      sessions.push(session);
      return session;
    },
    captureCopy: (s) => (s.doc as FakeDoc).text || null,
  };
  return { clock, sessions, auth, last: () => sessions[sessions.length - 1]!, options, logs };
}

/** The claims of a handshake token. */
export function decodeHandshake(token: string): { t: string; v?: string; e?: number } {
  const body = token.slice(3).replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(body.padEnd(Math.ceil(body.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as { t: string; v?: string; e?: number };
}
