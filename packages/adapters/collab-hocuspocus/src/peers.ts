import type { Peer } from 'crossws';
import { codeFor, GOING_AWAY } from './refusal.js';
import type { RefusalTable } from './refusal.js';

/** How long a refused socket stays open so the provider receives the refusal first; the contract allows 1 s. */
export const REFUSAL_CLOSE_DELAY_MS = 250;
/** How long a client gets to answer a going-away close before its socket is terminated. */
export const FORCE_CLOSE_MS = 1000;

interface Entry {
  readonly peer: Peer;
  authenticated: boolean;
  /** The documents authenticated on this socket, each with the user it was admitted for: one socket may carry documents of different users. */
  readonly documents: Map<string, string>;
  timer?: NodeJS.Timeout;
}

/** The sockets the host knows about. Hocuspocus rejects authentication without closing, and has no handle on sockets to close at shutdown. */
export class PeerRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly codes: RefusalTable) {}

  add(peerId: string, peer: Peer): void {
    this.entries.set(peerId, { peer, authenticated: false, documents: new Map() });
  }

  remove(peerId: string): void {
    const e = this.entries.get(peerId);
    if (e?.timer) clearTimeout(e.timer);
    this.entries.delete(peerId);
  }

  /** A document on this socket finished authentication and loading: the socket is no longer subject to the refusal close. */
  markAuthenticated(peerId: string, userId: string, documentName: string): void {
    const e = this.entries.get(peerId);
    if (!e) return;
    e.authenticated = true;
    e.documents.set(documentName, userId);
    if (e.timer) clearTimeout(e.timer);
    delete e.timer;
  }

  /** The connection for this document ended (closed by the server or by the client): it no longer belongs to any user. */
  releaseDocument(peerId: string, documentName: string): void {
    this.entries.get(peerId)?.documents.delete(documentName);
  }

  /** A connect-time refusal happened: close the socket shortly after, unless a document on it has authenticated. */
  refused(peerId: string, reason: string): void {
    const e = this.entries.get(peerId);
    if (!e || e.authenticated || e.timer) return;
    e.timer = setTimeout(() => {
      if (!e.authenticated) e.peer.close(codeFor(this.codes, reason), reason);
    }, REFUSAL_CLOSE_DELAY_MS);
  }

  /** Sends close 1001 "going away"; a socket whose client does not answer is terminated after a second so shutdown cannot wait on it. */
  closeAll(): void {
    for (const [id, e] of this.entries) this.goAway(id, e);
  }

  /**
   * Closes exactly one user's documents, on every socket: `closeDocument` is called for each (the host closes that document's connection).
   * A socket on which every document is this user's is closed as well; a socket that also carries another user's document stays open.
   */
  closeUser(userId: string, closeDocument: (peerId: string, documentName: string) => void): void {
    const owned: [string, Entry, string[]][] = [];
    for (const [id, e] of this.entries) {
      const mine = [...e.documents].filter(([, u]) => u === userId).map(([d]) => d);
      if (mine.length > 0) owned.push([id, e, mine]);
    }
    for (const [id, e, mine] of owned) {
      const exclusive = mine.length === e.documents.size;
      for (const d of mine) closeDocument(id, d);
      if (exclusive) this.goAway(id, e);
    }
  }

  private goAway(id: string, e: Entry): void {
    e.peer.close(GOING_AWAY.code, GOING_AWAY.reason);
    setTimeout(() => { if (this.entries.has(id)) e.peer.terminate(); }, FORCE_CLOSE_MS).unref();
  }

  get size(): number { return this.entries.size; }
}
