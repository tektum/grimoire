// Helpers of the milestone 4 end-to-end test (`make test-m4`). They extend the collaboration harness (../support.ts: scenario runner, peers, development tokens,
// the Compose helpers): the app runs in local mode, the three people of the development data sign in with development tokens, and every HTTP request goes
// through the generated client of packages/api-client, never a hand-written fetch.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { createApiClient } from '@tektum/grimoire-api-client';
import { createDatabase } from '@tektum/grimoire-adapter-db-kysely';
import * as Y from 'yjs';
import { BASE, ORIGIN, WS_URL, appEvents, compose, devToken, eventually, originSocket, repoRoot, scenario } from '../support.ts';
import type { T } from '../support.ts';

// The collaboration runner writes to test-results/m1 unless told otherwise: these scenarios write to test-results/m4.
process.env['E2E_RESULTS_DIR'] ??= 'test-results/m4';

export { BASE, appEvents, compose, eventually, scenario };
export type { T };

/** The people of the development data (alice administrator, bob member, carol viewer) and their roles. */
export const PEOPLE = { alice: 'admin', bob: 'member', carol: 'viewer' } as const;
export type Person = keyof typeof PEOPLE;

/** A client signed in as `person`; `anonymous` sends no token. */
export const apiAs = (person: Person) => createApiClient({ baseUrl: BASE, getToken: () => devToken(person, PEOPLE[person]) });
export const anonymous = () => createApiClient({ baseUrl: BASE });
/** A client that sends exactly this token, whatever it is. */
export const apiWithToken = (token: string) => createApiClient({ baseUrl: BASE, getToken: () => token });

/** The part of an `openapi-fetch` answer these helpers read. */
interface Answer<D> { readonly data?: D; readonly error?: unknown; readonly response: Response }

/** The body of an answer that must have `status`; anything else is a failure naming what was attempted and what the server said. */
export function expectStatus<D>(answer: Answer<D>, status: number, what: string): D {
  if (answer.response.status !== status) {
    throw new Error(`${what}: expected ${String(status)}, got ${String(answer.response.status)} ${JSON.stringify(answer.error ?? answer.data ?? null)}`);
  }
  return answer.data as D;
}

/** The error code of the server's envelope in an answer, or undefined. */
export const errorCode = (answer: { readonly error?: unknown }): string | undefined => (answer.error as { error?: { code?: string } } | undefined)?.error?.code;

/** A name that no earlier run used. */
export const unique = (prefix: string): string => `${prefix} ${randomUUID().slice(0, 8)}`;

/** The user ids the server gave the three people, read from `GET /v1/me` (the first call of a person provisions the row). */
export async function signInAll(): Promise<Record<Person, string>> {
  const out = {} as Record<Person, string>;
  for (const person of Object.keys(PEOPLE) as Person[]) {
    const me = expectStatus(await apiAs(person).GET('/v1/me'), 200, `${person} signs in`);
    if (me.role !== PEOPLE[person]) throw new Error(`${person} has the role ${me.role}, expected ${PEOPLE[person]}`);
    out[person] = me.id;
  }
  return out;
}

// ---- the database, as the runtime role --------------------------------------------------------------------------------------------------

function devPassword(): string {
  const fromEnv = process.env['GRIMOIRE_DEV_DB_PASSWORD'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const m = /^GRIMOIRE_DEV_DB_PASSWORD=(.*)$/m.exec(readFileSync(path.join(repoRoot, '.env'), 'utf8'));
    if (m?.[1] !== undefined) return m[1].trim();
  } catch { /* no .env */ }
  return 'grimoire-dev';
}
const db = createDatabase(`postgresql://grimoire_app:${devPassword()}@127.0.0.1:55432/grimoire`, { maxConnections: 2 });
export const closeDb = (): Promise<void> => db.close();
export const query = <R>(sql: string, params: readonly unknown[] = []): Promise<readonly R[]> => db.query<R>(sql, params);

// ---- a browser tab: the provider the way the web client runs it ------------------------------------------------------------------------

export interface Tab {
  readonly doc: Y.Doc;
  readonly provider: HocuspocusProvider;
  /** Each close of the document with its code and reason. */
  readonly closes: { readonly code: number; readonly reason: string }[];
  /** The close code of every socket the tab opened, as seen on the wire (the provider's own events do not report a refused connect). */
  readonly wireCloses: number[];
  /** Each refusal the provider was told (`stale-epoch`, ...). */
  readonly failures: string[];
  /** The state epoch the server last told this tab. */
  recorded(): number | undefined;
  /** The tab loses its network: the socket drops and the provider reconnects by itself, carrying the epoch it recorded. */
  dropSocket(): void;
  destroy(): void;
}

/** The connect-time token the web client sends: the session token and the state epoch the server last told it (R4.32). */
const wrapped = (token: string, epoch: number | undefined): string => `g1.${Buffer.from(JSON.stringify({ t: token, ...(epoch === undefined ? {} : { e: epoch }) })).toString('base64url')}`;

export function tab(pageId: string, person: Person): Tab {
  const doc = new Y.Doc();
  const closes: { code: number; reason: string }[] = [];
  const failures: string[] = [];
  let recorded: number | undefined;
  const wireCloses: number[] = [];
  const Base = originSocket(ORIGIN);
  class Recording extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('close', (event) => { wireCloses.push(event.code); });
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url: WS_URL, WebSocketPolyfill: Recording });
  const provider = new HocuspocusProvider({
    name: pageId, document: doc, websocketProvider: socket, token: () => wrapped(devToken(person, PEOPLE[person]), recorded),
    onStateless: ({ payload }) => { const m = JSON.parse(payload) as { kind?: string; epoch?: number }; if (m.kind === 'epoch') recorded = m.epoch; },
    onAuthenticationFailed: ({ reason }) => { failures.push(reason); },
    onClose: ({ event }) => { closes.push({ code: event.code, reason: event.reason }); },
  });
  provider.attach();
  return {
    doc, provider, closes, wireCloses, failures, recorded: () => recorded,
    dropSocket: () => { provider.configuration.websocketProvider.webSocket?.close(); },
    destroy: () => { provider.destroy(); socket.destroy(); },
  };
}

// ---- small builders ---------------------------------------------------------------------------------------------------------------------

/** A collection everybody may write in, made by the administrator. */
export async function openCollection(name: string): Promise<string> {
  const made = expectStatus(await apiAs('alice').POST('/v1/collections', { body: { name: unique(name), defaultPermission: 'read_write' } }), 201, 'the administrator creates a collection');
  return made.id;
}

/** The saved Markdown of a page, as the API serves it. */
export async function savedMarkdown(person: Person, pageId: string): Promise<string> {
  return expectStatus(await apiAs(person).GET('/v1/pages/{id}/markdown', { params: { path: { id: pageId } }, parseAs: 'text' }), 200, 'the saved Markdown');
}

/** For `eventually`, which polls every 25 ms: calls `fn` at most once per `everyMs`, so a wait on the API stays far below the per-user request limit. */
export function throttled<T>(fn: () => Promise<T | undefined>, everyMs = 500): () => Promise<T | undefined> {
  let last = 0;
  return async () => {
    if (Date.now() - last < everyMs) return undefined;
    last = Date.now();
    return fn();
  };
}
