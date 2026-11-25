// Shared pieces of the end-to-end harness. Scenarios run as separate Node processes (`node scenarios/<name>.ts`, type stripping).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { createDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { eventually, originSocket, waitUntil } from '@tektum/grimoire-test-support/e2e';
import { insertPage } from '@tektum/grimoire-test-support/database';
import * as Y from 'yjs';

const run = promisify(execFile);
export const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');
export const BASE = 'http://127.0.0.1:8080';
export const WS_URL = 'ws://127.0.0.1:8080/collab';
/** The origin `compose.yaml` allows (GRIMOIRE_ALLOWED_ORIGINS). */
export const ORIGIN = 'http://127.0.0.1:8080';
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- scenario runner -------------------------------------------------------------------------------------------------------------

export type Rng = () => number;
/** mulberry32: a seeded generator, so a failing run can be repeated with E2E_SEED. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface T {
  readonly seed: number;
  readonly rng: Rng;
  /** One assertion: throws (failing the scenario) when `ok` is false. */
  check(ok: boolean, what: string): void;
  equal<V>(actual: V, expected: V, what: string): void;
  metric(key: string, value: unknown): void;
  /** Registers a cleanup that runs after the scenario, pass or fail. */
  onDone(fn: () => void | Promise<void>): void;
}

class Failure extends Error {}

/** Runs one scenario in this process: prints `PASS <name>` or `FAIL <name>: <reason>` (with the seed) and writes the JSON result. */
export async function scenario(name: string, timeoutMs: number, body: (t: T) => Promise<void>): Promise<never> {
  const seed = Number(process.env['E2E_SEED'] ?? Math.floor(Math.random() * 2 ** 31));
  const checks: string[] = [];
  const metrics: Record<string, unknown> = {};
  const cleanups: (() => void | Promise<void>)[] = [];
  const t: T = {
    seed, rng: seeded(seed),
    check(ok, what) { if (!ok) throw new Failure(what); checks.push(what); },
    equal(actual, expected, what) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Failure(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      checks.push(what);
    },
    metric(key, value) { metrics[key] = value; },
    onDone(fn) { cleanups.push(fn); },
  };
  const started = Date.now();
  let failure: string | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanupErrors: string[] = [];
  // One run, shared: a watchdog or a signal that fires while the normal cleanup is running waits for that same run, so the process never exits mid-restore.
  const runCleanups = (): Promise<void> => {
    cleaning ??= (async () => {
      for (const fn of cleanups.reverse()) { try { await fn(); } catch (e) { cleanupErrors.push(e instanceof Error ? e.message : String(e)); } }
      // A restore that failed leaves the stack changed for the next scenario: the scenario fails (it must never print PASS over it).
      if (cleanupErrors.length > 0) failure ??= `cleanup failed: ${cleanupErrors.join('; ')}`;
    })();
    return cleaning;
  };
  // A timeout or Ctrl-C must also restore what the scenario changed (grants, a stopped app), not only a normal or failed exit.
  const timer = setTimeout(() => { failure = `timed out after ${String(timeoutMs)} ms`; void runCleanups().then(finish); }, timeoutMs);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => { failure ??= `interrupted by ${sig}`; void runCleanups().then(finish); });
  }
  let finished = false;
  function finish(): void {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    const status = failure === undefined ? 'pass' : 'fail';
    const dir = path.resolve(repoRoot, process.env['E2E_RESULTS_DIR'] ?? 'test-results/m1');
    mkdirSync(dir, { recursive: true });
    const result = { scenario: name, status, durationMs: Date.now() - started, assertions: checks.length, seed, ...(failure === undefined ? {} : { reason: failure }), ...metrics, checks };
    writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(failure === undefined ? `PASS ${name}\n` : `FAIL ${name}: ${failure.replaceAll('\n', ' ')} (seed ${String(seed)})\n`);
    process.exit(failure === undefined ? 0 : 1);
  }
  try {
    await body(t);
  } catch (e) {
    failure ??= e instanceof Error ? e.message : String(e);
  }
  await runCleanups();
  finish();
  return new Promise<never>(() => undefined);
}

export { eventually, waitUntil };

// ---- Docker Compose (the stack started by `make up`; project name fixed, COMPOSE_FILE honoured) ----------------------------------

export async function compose(...args: string[]): Promise<string> {
  const r = await run('docker', ['compose', '-p', 'grimoire', ...args], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return r.stdout;
}
export const killApp = (signal: string): Promise<string> => compose('kill', '-s', signal, 'app');
export const startApp = (): Promise<string> => compose('start', 'app');

export async function waitReady(timeoutMs = 90_000): Promise<void> {
  await eventually(async () => {
    try { return (await fetch(`${BASE}/readyz`)).ok ? true : undefined; } catch { return undefined; }
  }, timeoutMs, 'the app to answer /readyz');
}

/** Waits for the app container to stop and returns its exit code. */
export async function waitExit(timeoutMs: number): Promise<number> {
  return eventually(async () => {
    const id = (await compose('ps', '-aq', 'app')).trim();
    const out = (await run('docker', ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', id])).stdout.trim().split(' ');
    return out[0] === 'exited' ? Number(out[1]) : undefined;
  }, timeoutMs, 'the app container to exit');
}

export interface LogEvent { readonly event: string; readonly [k: string]: unknown }
/** The JSON log lines the app wrote since `since` (an ISO time); other lines are ignored. */
export async function appEvents(since: Date): Promise<LogEvent[]> {
  const out = await compose('logs', '--no-log-prefix', '--since', since.toISOString(), 'app');
  const events: LogEvent[] = [];
  for (const line of out.split('\n')) {
    try {
      const v: unknown = JSON.parse(line);
      if (typeof v === 'object' && v !== null && 'event' in v && typeof v.event === 'string') events.push({ ...Object.fromEntries(Object.entries(v)), event: v.event });
    } catch { /* not a JSON line */ }
  }
  return events;
}

/** Runs SQL as the admin role inside the PostgreSQL container (the harness needs REVOKE and GRANT, which the runtime role cannot do). */
export async function psqlAdmin(sql: string): Promise<void> {
  await compose('exec', '-T', 'postgres', 'psql', '-U', 'grimoire_admin', '-d', 'grimoire', '-v', 'ON_ERROR_STOP=1', '-c', sql);
}

/** The development token secret `make up` generated into `.env` (or GRIMOIRE_DEV_TOKEN_SECRET in the environment): the running stack requires it in every token. */
function devSecret(): string {
  const fromEnv = process.env['GRIMOIRE_DEV_TOKEN_SECRET'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const m = /^GRIMOIRE_DEV_TOKEN_SECRET=(.+)$/m.exec(readFileSync(path.join(repoRoot, '.env'), 'utf8'));
  if (m?.[1] === undefined) throw new Error('GRIMOIRE_DEV_TOKEN_SECRET is not set and .env has none: run `make up` first');
  return m[1].trim();
}
export const devToken = (user: string, role: string): string => `dev:${devSecret()}:${user}:${role}`;

// ---- database (runtime role, as the app itself connects) -----------------------------------------------------------------------

function devPassword(): string {
  const fromEnv = process.env['GRIMOIRE_DEV_DB_PASSWORD'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const m = /^GRIMOIRE_DEV_DB_PASSWORD=(.*)$/m.exec(readFileSync(path.join(repoRoot, '.env'), 'utf8'));
    if (m?.[1] !== undefined) return m[1].trim();
  } catch { /* no .env */ }
  return 'grimoire-dev';
}
// The scenarios' own reads and seeds, as the operator role: it has the runtime role's grants (it is a member of it) and a row-level security policy that passes every
// tenant's rows (migration 0014). The runtime role sees only the rows of the tenant its transaction set, and these fixtures set none (docs/tenancy.md section 3.2).
const db = createDatabase(`postgresql://grimoire_ops:${devPassword()}@127.0.0.1:55432/grimoire`, { maxConnections: 2 });
export const closeDb = (): Promise<void> => db.close();

/** The development collection "Dev" (contracts section 4, default read_write): every dev member may edit its pages, a viewer reads them. */
export const DEV_COLLECTION = '00000000-0000-4000-8000-0000000000d1';
/**
 * a page opens only for a user the authorisation rule allows; the earlier authorisation stub let any signed-in user open any page. The
 * scenarios therefore put their pages into "Dev" through the real tables (idempotent); dev users get their rows at first sign-in
 * (local mode provisions with the token's role).
 */
export async function ensureDevCollection(): Promise<void> {
  await db.query(`insert into collections (id, name, position, default_permission, created_by) values ($1, 'Dev', 'a0', 'read_write', '00000000-0000-4000-8000-000000000001') on conflict do nothing`, [DEV_COLLECTION]);
}

/** The `users.id` of a dev subject (its row is created at first sign-in). */
export async function userIdOf(subject: string): Promise<string> {
  const rows = await db.query<{ id: string }>('select id::text as id from users where descope_user_id = $1', [subject]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`no user row for ${subject}`);
  return id;
}

/** Inserts a page row in "Dev" through the operator role (see `db` above) and returns its id. */
export async function newPage(): Promise<string> {
  const id = randomUUID();
  await ensureDevCollection();
  await insertPage((sql) => db.query(sql), { id, collection_id: DEV_COLLECTION });
  return id;
}
interface Row { ydoc: Uint8Array | null }
export async function storedState(id: string): Promise<Uint8Array | null> {
  const rows = await db.query<Row>(`select ydoc from pages where id = '${id}'`);
  const v = rows[0]?.ydoc;
  return v ? new Uint8Array(v) : null;
}
export function textOf(state: Uint8Array | null): string {
  const d = new Y.Doc();
  if (state) Y.applyUpdate(d, state);
  return d.getText('prosemirror').toString();
}
export async function storedText(id: string): Promise<string> { return textOf(await storedState(id)); }

// ---- clients ------------------------------------------------------------------------------------------------------------------------

/** Node's global WebSocket sends no Origin; undici accepts headers in its init dictionary, and the provider passes one argument. */
export { originSocket };

export interface Peer {
  readonly user: string;
  readonly provider: HocuspocusProvider;
  /** The provider's own socket: `disconnect()` and `connect()` here take the client offline and back. */
  readonly socket: HocuspocusProviderWebsocket;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly stateless: string[];
  readonly failures: string[];
  readonly closes: number[];
  /** Each close with its code and its reason string (the reasons the server sends: `access-changed`, `session-expired`, `invalid-token`, `try-again`, ...). */
  readonly closed: { readonly code: number; readonly reason: string }[];
  destroy(): void;
}
export interface PeerOptions { readonly token?: string | (() => string); readonly origin?: string }
/** One provider with its own Yjs document and its own Origin header (a distinct user per peer: the caps are per user and page). */
export function peer(page: string, user: string, role = 'member', opts: PeerOptions = {}): Peer {
  const stateless: string[] = []; const failures: string[] = []; const closes: number[] = []; const closed: { code: number; reason: string }[] = [];
  const doc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({ url: WS_URL, WebSocketPolyfill: originSocket(opts.origin ?? ORIGIN) });
  const provider = new HocuspocusProvider({
    name: page, token: opts.token ?? devToken(user, role), document: doc,
    websocketProvider: socket,
    onStateless: ({ payload }) => { stateless.push(payload); },
    onAuthenticationFailed: ({ reason }) => { failures.push(reason); },
    onClose: ({ event }) => { closes.push(event.code); closed.push({ code: event.code, reason: event.reason }); },
  });
  provider.attach();
  return { user, provider, socket, doc, text: doc.getText('prosemirror'), stateless, failures, closes, closed, destroy: () => { provider.destroy(); socket.destroy(); } };
}
export const isSynced = (p: Peer): boolean => p.provider.synced;
export const synced = (p: Peer, timeoutMs = 10_000): Promise<void> => eventually(() => (p.provider.synced ? true : undefined), timeoutMs, `${p.user} synced`).then(() => undefined);

// ---- typing model ---------------------------------------------------------------------------------------------------------------

/**
 * A person typing: inserts whole tokens `<tag run.seq>` (for example `<a3.17>`) at a caret that follows the previous token, and
 * now and then jumps to a random place and starts a new run. Within a run, order must survive any merge; every token must appear
 * exactly once. `dropEvery` is the harness mutation "drop a character before sending".
 */
export class Typist {
  readonly typed: string[] = [];
  private run = 0; private seq = 0; private caret: Y.RelativePosition | null = null;
  private readonly tag: string; private readonly peer: Peer; private readonly rng: Rng; private readonly dropAt: number;
  constructor(tag: string, p: Peer, rng: Rng, dropAt = -1) { this.tag = tag; this.peer = p; this.rng = rng; this.dropAt = dropAt; }
  type(): string {
    const text = this.peer.text;
    if (this.caret === null || this.rng() < 0.1) {
      this.run += 1; this.seq = 0;
      // A jump lands between whole tokens (a person's caret is between characters, but a token stands for one typed unit).
      const whole = text.toString();
      const boundaries = [0, ...[...whole.matchAll(/>/g)].map((m) => m.index + 1)];
      this.caret = Y.createRelativePositionFromTypeIndex(text, boundaries[Math.floor(this.rng() * boundaries.length)] ?? 0, -1);
    }
    const index = Y.createAbsolutePositionFromRelativePosition(this.caret, this.peer.doc)?.index ?? text.length;
    const token = `<${this.tag}${String(this.run)}.${String(this.seq)}>`;
    this.seq += 1;
    const sent = this.typed.length === this.dropAt ? token.slice(0, -1) : token;
    text.insert(index, sent);
    this.typed.push(token);
    this.caret = Y.createRelativePositionFromTypeIndex(text, index + sent.length, -1);
    return token;
  }
}

export interface Verdict { readonly problems: string[]; readonly characters: number }
/** CONTENT check: every expected token exactly once, nothing else in the text, and per run the tokens in typing order. */
export function verifyTokens(content: string, expected: readonly string[]): Verdict {
  const found = [...content.matchAll(/<([a-z0-9]+?)(\d+)\.(\d+)>/g)];
  const counts = new Map<string, number>();
  const lastSeq = new Map<string, number>();
  const problems: string[] = [];
  for (const m of found) {
    counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    const run = `${m[1] ?? ''}${m[2] ?? ''}`; const seq = Number(m[3]);
    if (seq <= (lastSeq.get(run) ?? -1)) problems.push(`order: ${m[0]} after a later token of the same run`);
    lastSeq.set(run, seq);
  }
  let characters = 0;
  for (const tok of expected) {
    const n = counts.get(tok) ?? 0;
    if (n === 1) characters += tok.length; else problems.push(`${tok} present ${String(n)} times`);
  }
  const rest = content.replace(/<([a-z0-9]+?)(\d+)\.(\d+)>/g, '');
  if (rest !== '') problems.push(`stray characters: ${JSON.stringify(rest.slice(0, 40))}`);
  const extra = [...counts.keys()].filter((k) => !expected.includes(k));
  if (extra.length > 0) problems.push(`unexpected tokens: ${extra.slice(0, 3).join(' ')}`);
  return { problems: problems.slice(0, 5), characters };
}
export const sameText = (peers: readonly Peer[]): boolean => peers.every((p) => p.text.toString() === peers[0]?.text.toString());
