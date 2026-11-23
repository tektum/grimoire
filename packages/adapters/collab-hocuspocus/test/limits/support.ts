import type { CollabConfig } from '@tektum/grimoire-core/ports/config';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import * as Y from 'yjs';
import { createCollabLog } from '../../src/events.js';
import { createLimitsExtension } from '../../src/extensions/limits.js';
import type { LimitsExtension } from '../../src/extensions/limits.js';

export const pageName = (i: number): string => `0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e${String(i).padStart(4, '0')}`;

/** A text document and the bytes of one insert into it, for building updates of a known size. */
export function updateOf(text: string, base?: Y.Doc): Uint8Array {
  const d = new Y.Doc();
  if (base) Y.applyUpdate(d, Y.encodeStateAsUpdate(base));
  const before = Y.encodeStateVector(d);
  d.getText('prosemirror').insert(0, text);
  return Y.encodeStateAsUpdate(d, before);
}

export interface FakeConnection {
  readonly sent: string[];
  readonly closes: { code: number; reason: string }[];
  /** The closes of the whole socket (a subset of `closes`): every document on it goes. */
  readonly socketCloses: { code: number; reason: string }[];
  readonly replayed: Uint8Array[];
  readonly connection: {
    readOnly: boolean; document: unknown; socketId: string;
    sendStateless(p: string): void; handleMessage(f: Uint8Array): void; webSocket: { close(code: number, reason: string): void };
    /** Closes this document connection only (the socket and its other documents stay). */
    close(event?: { code: number; reason: string }): void;
  };
}

export interface Harness {
  readonly ext: LimitsExtension;
  readonly logger: FakeLogger;
  readonly documents: Map<string, unknown>;
  readonly unloaded: unknown[];
  readonly instance: { documents: Map<string, unknown>; getDocumentsCount(): number; unloadDocument(d: unknown): Promise<void> };
  memory: number;
  /** A document with a name and the connections it should report. */
  doc(name: string, connections?: FakeConnection[]): Y.Doc & { name: string };
  conn(socketId: string, doc: unknown, readOnly?: boolean): FakeConnection;
  open(payload: { documentName: string; socketId: string; connection: unknown; userId?: string; context?: unknown }): Promise<void>;
  connect(name: string, socketId: string): Promise<void>;
  disconnect(name: string, socketId: string, clientsCount?: number, document?: unknown): Promise<void>;
  tryConnect(name: string, socketId?: string): Promise<void>;
  limitHits(): { limit: string; value: number; max: number; pageId?: string }[];
}

export function harness(collab: Partial<CollabConfig> = {}, clock = { now: () => Date.now() }): Harness {
  const logger = new FakeLogger();
  const documents = new Map<string, unknown>();
  const unloaded: unknown[] = [];
  const instance = {
    documents,
    getDocumentsCount: () => documents.size,
    unloadDocument: (d: unknown) => { unloaded.push(d); return Promise.resolve(); },
  };
  const closers = new Map<string, (() => void)[]>();
  const h: Harness = {
    ext: createLimitsExtension({ config: makeFakeConfig({ collab }).collab, clock, log: createCollabLog(logger), memoryUsed: () => h.memory }),
    logger, documents, unloaded, instance, memory: 0,
    doc(name, connections = []) {
      const d = Object.assign(new Y.Doc(), { name, getConnections: () => connections.map((c) => c.connection), getConnectionsCount: () => connections.length, hasConnection: () => true });
      return d;
    },
    conn(socketId, doc, readOnly = false) {
      const key = `${(doc as { name?: string } | null)?.name ?? ''}\0${socketId}`;
      const closing = closers.get(key) ?? [];
      closers.set(key, closing);
      const sent: string[] = [];
      const closes: { code: number; reason: string }[] = [];
      const socketCloses: { code: number; reason: string }[] = [];
      const replayed: Uint8Array[] = [];
      return {
        sent, closes, socketCloses, replayed,
        connection: {
          readOnly, document: doc, socketId,
          sendStateless: (p: string) => { sent.push(p); },
          handleMessage: (f: Uint8Array) => { replayed.push(f); },
          webSocket: { close: (code: number, reason: string) => { closes.push({ code, reason }); socketCloses.push({ code, reason }); } },
          close: (event?: { code: number; reason: string }) => { if (event) closes.push(event); },
          onClose: (fn: () => void) => { closing.push(fn); },
        },
      };
    },
    /** What Hocuspocus does for one document opening: the admission at arrival (the auth extension calls it with the verified user), then `connected` once the page has loaded. */
    async open(payload) {
      const connectionConfig = {}; // Hocuspocus makes one per open and passes the same object to every hook of it
      h.ext.admit({ context: payload.context ?? {}, socketId: payload.socketId, documentName: payload.documentName, connectionConfig }, payload.userId);
      await h.ext.connected?.({ ...payload, connectionConfig } as never);
    },
    async connect(name, socketId) {
      const document = h.documents.get(name) ?? h.doc(name);
      h.documents.set(name, document);
      await h.open({ documentName: name, socketId, connection: h.conn(socketId, document).connection });
    },
    async disconnect(name, socketId, clientsCount = 0, document = h.documents.get(name)) {
      const one = closers.get(`${name}\0${socketId}`)?.shift(); // one connection closes at a time
      one?.(); // what Hocuspocus does first: the connection's own close handlers
      await h.ext.onDisconnect?.({ documentName: name, socketId, clientsCount, document, instance } as never);
    },
    async tryConnect(name, socketId = 'probe') {
      await h.ext.onConnect?.({ documentName: name, socketId, instance } as never);
    },
    limitHits() {
      return h.logger.entries.filter((e) => e.event === 'collab.limit_hit').map((e) => e.fields as never);
    },
  };
  return h;
}

/** Frames as they arrive in `beforeHandleMessage`: document name 'a', then the Hocuspocus message type (0 sync, 1 awareness, 3 query awareness). */
export const frame = (type: number): Uint8Array => Uint8Array.from([1, 97, type, 0]);
