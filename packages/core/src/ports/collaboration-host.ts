import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PageAccessChecker } from '../authorize/index.js';
import type { AuthVerifier, Profile } from './auth-verifier.js';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
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
  /** Ids of pages whose Markdown is stale, oldest first (the sweep's query; the sweep itself belongs to the jobs milestone). */
  listStale(limit: number): Promise<string[]>;
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
  readonly resolveUser: (token: string, identity: { readonly userId: string; readonly profile?: Profile }) => Promise<UserRecord | undefined>;
  /** The collapsed authorisation answer (R4.10, R6.4); the host never sees a deny reason. */
  readonly access: PageAccessChecker;
  readonly pages: PageStore;
  readonly converter: MarkdownConverter;
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
   */
  closeConnections(filter?: { userId?: string; documentName?: string }): Promise<void>;
  /** Refuses new upgrades, closes sockets, stores every loaded page, gives up at the deadline. */
  shutdown(o: { deadlineMs: number }): Promise<ShutdownReport>;
}
