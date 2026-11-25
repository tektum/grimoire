import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PageAccessChecker } from '../authorize/index.js';
import type { AuthVerifier, Profile, TenantClaim } from './auth-verifier.js';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { RevisionRepo } from './revision-repo.js';
import type { MarkdownConverter } from './markdown-converter.js';
import type { UserRecord } from './user-store.js';

/** What a page row holds that the host needs. No Yjs type here: the state is opaque bytes. */
export interface StoredPage {
  /** `null` when the row has no state yet (it is seeded from `markdown` or starts empty). */
  state: Uint8Array | null;
  markdown: string | null;
  markdownHash: Uint8Array | null;
  /** `state_epoch` of the row; a save is refused when it differs. */
  epoch: number;
  /** Epoch milliseconds since when the Markdown is older than the state (a save stored the state without fresh Markdown); `null`: current. */
  markdownStaleSince: number | null;
}

export type PageWrite =
  | { kind: 'converted'; state: Uint8Array; markdown: string; text: string; epoch: number; editedBy?: string; editedAt: number }
  | { kind: 'state-only'; state: Uint8Array; epoch: number };

export type WriteOutcome = { written: true } | { written: false; reason: 'unchanged' | 'epoch-mismatch' | 'no-row' };

/** Where a page's collaborative state and Markdown live (table `pages`). */
export interface PageStore {
  /** `undefined` = there is no such row (the page does not exist). */
  load(id: string): Promise<StoredPage | undefined>;
  /** One transaction under a row lock: returns the stored state, or builds it from the row's Markdown, writes it and returns it (`seeded: true`). `state: null`: nothing to seed. */
  seed(id: string, build: (markdown: string) => Promise<Uint8Array>): Promise<{ state: Uint8Array | null; seeded: boolean; epoch: number }>;
  /** One transaction under a row lock. Rejects when the database cannot take it; the host retries. */
  store(id: string, w: PageWrite): Promise<WriteOutcome>;
  /** Pages whose Markdown is stale, oldest mark first, each with the time of its mark (epoch milliseconds): the sweep's query. A page whose mark was cleared and set again has a new time. */
  listStale(limit: number): Promise<{ readonly id: string; readonly staleSince: number }[]>;
  /**
   * The sweep's write, a compare-and-set: stores `markdown` and `text` for a page whose Markdown is stale, only while its row still holds exactly the `state`
   * and `epoch` the conversion was made from (checked under the row lock), and clears the mark. Anything else (a save in between, a reset, no mark, no row)
   * writes nothing and answers `skipped`; the page is tried again at the next sweep. The editor state and the last edit are never touched.
   */
  repairMarkdown(id: string, seen: { readonly state: Uint8Array; readonly epoch: number }, converted: { readonly markdown: string; readonly text: string }): Promise<'repaired' | 'skipped'>;
}

export interface CollabDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly verifier: AuthVerifier;
  /**
   * The user row of a verified identity (contracts section 2): outside local mode `users.findByDescopeId` (no provisioning on the
   * WebSocket path), in local mode the provisioner with the development role. `undefined`: no such user (refused `forbidden`).
   * The host refuses a returned row that is suspended; it never relies on this function for that. Rejects when the database fails.
   */
  readonly resolveUser: (token: string, identity: { readonly userId: string; readonly profile?: Profile; readonly tenant?: TenantClaim }) => Promise<UserRecord | undefined>;
  /**
   * Refuse a token whose tenant is none or several (docs/tenancy.md, section 6) at the handshake. Off (the default) until the sign-in flow that gives every person a tenant is in
   * place, so that tokens that predate it are not locked out; the server composition turns it on together with the API's own refusal of the same tokens.
   */
  readonly requireTenant?: boolean;
  /** The collapsed authorisation answer (R4.10, R6.4); the host never sees a deny reason. */
  readonly access: PageAccessChecker;
  readonly pages: PageStore;
  readonly converter: MarkdownConverter;
  /** Unused by the host until M4-T08. */
  readonly revisions: RevisionRepo;
}

export interface ShutdownReport {
  /** Pages whose latest edits could not be stored before the deadline. */
  readonly abandonedPages: number;
}

export interface CollaborationHost {
  start(deps: CollabDeps): Promise<void>;
  /** Takes over an HTTP upgrade request the server already routed to the collaboration path. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /**
   * Closes sockets (all, or those of one user) or one page's connections. Does not wait for stores. The contract defines it for the
   * access re-check and revocation of milestone 3 (R4.13, R4.48), which closes by user and by page; nothing in the server calls it yet.
   * `refusalReason` names the close the clients see on a user's or a page's connections: its code is the one registered for that refusal
   * reason (a reset or restore closes a page with `stale-epoch`, 4409), so a client can tell it from a network drop. Without it a user's
   * connections end with 1001 and a page's with the library's reset close. Closing everything is always 1001.
   */
  closeConnections(filter?: { userId?: string; documentName?: string }, refusalReason?: string): Promise<void>;
  /** Refuses new upgrades, closes sockets, stores every loaded page, gives up at the deadline. */
  shutdown(o: { deadlineMs: number }): Promise<ShutdownReport>;
}
