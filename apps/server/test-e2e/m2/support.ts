// Helpers of the Markdown end-to-end test. They extend the collaboration harness (../support.ts: Origin handling, tokens, Compose helpers, the scenario runner)
// and add what the collaboration scenarios have no use for: real editor documents (the shared schema through the reference editor), rows with Markdown, and the converter.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as encoding from 'lib0/encoding';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { createDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { convertInProcess, seedInProcess } from '@tektum/grimoire-adapter-markdown-milkdown';
import * as Y from 'yjs';
import { createReferenceEditor, installDom } from './reference-editor.mjs';
import type { ReferenceEditor } from './reference-editor.mjs';
import { BASE, DEV_COLLECTION, ORIGIN, WS_URL, devToken, ensureDevCollection, eventually, originSocket, repoRoot, waitReady } from '../support.ts';
import type { Rng } from '../support.ts';

// The collaboration runner writes to test-results/m1 unless told otherwise: the scenarios of these scenarios write to test-results/m2.
process.env['E2E_RESULTS_DIR'] ??= 'test-results/m2';

const exec = promisify(execFile);
export const FRAGMENT = 'prosemirror';
// The reference editor installs happy-dom's Event and CustomEvent as globals, and Node's WebSocket (undici) then rejects its own events:
// keep Node's classes and put them back after every editor is created. ProseMirror reads the DOM through `window`/`document`, not these two.
const NODE_EVENT = globalThis.Event; const NODE_CUSTOM_EVENT = globalThis.CustomEvent;
const setEvents = (event: unknown, custom: unknown): void => {
  Object.defineProperty(globalThis, 'Event', { value: event, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'CustomEvent', { value: custom, configurable: true, writable: true });
};
/** Node's WebSocket (undici) rejects events that are not Node's own; the reference editor needs happy-dom's `Event` and `CustomEvent` only while it starts. */
async function makeEditor(options: { ydoc: Y.Doc }): Promise<ReferenceEditor> {
  const win = installDom();
  setEvents(Reflect.get(win, 'Event'), Reflect.get(win, 'CustomEvent'));
  try { return await createReferenceEditor(options.ydoc); } finally { setEvents(NODE_EVENT, NODE_CUSTOM_EVENT); }
}

// ---- database ---------------------------------------------------------------------------------------------------------------------
// A second handle on the same URL as ../support.ts: that module keeps its handle private, and it is not an owned file of this task.

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
export const closeM2Db = (): Promise<void> => db.close();

export interface Row {
  readonly ydoc: Uint8Array | null; readonly markdown: string | null; readonly text_content: string | null;
  readonly markdown_hash: Uint8Array | null; readonly updated_at: string; readonly ydoc_size: number | null; readonly last_edited_by: string | null;
}
export async function rowOf(id: string): Promise<Row | undefined> {
  const rows = await db.query<Row>('select ydoc, ydoc_size, markdown, text_content, markdown_hash, last_edited_by::text as last_edited_by, updated_at::text as updated_at from pages where id = $1', [id]);
  const r = rows[0];
  return r === undefined ? undefined : { ...r, ydoc: r.ydoc ? new Uint8Array(r.ydoc) : null, markdown_hash: r.markdown_hash ? new Uint8Array(r.markdown_hash) : null };
}
/** Inserts a page that has Markdown and no Yjs state (the shape of an imported page); returns its id. */
export async function insertSeededPage(id: string, markdown: string): Promise<void> {
  await ensureDevCollection();
  await db.query('insert into pages (id, collection_id, markdown) values ($1, $2, $3)', [id, DEV_COLLECTION, markdown]);
}

// ---- the converter the server uses, in process --------------------------------------------------------------------------------------

export async function canonicalOfState(state: Uint8Array): Promise<string> {
  const r = await convertInProcess(state);
  if (!r.ok) throw new Error(`conversion refused: ${r.reason}: ${"detail" in r ? String(r.detail) : ""}`);
  return r.markdown;
}
export async function stateOfMarkdown(markdown: string): Promise<Uint8Array> {
  const r = await seedInProcess(markdown);
  if (!r.ok) throw new Error(`seed refused: ${r.reason}`);
  return r.state;
}

// ---- clients -----------------------------------------------------------------------------------------------------------------------

/** A client whose document is a real editor document. It is not `peer()` of ../support.ts: that one creates a Y.Text named like the fragment. */
export interface DocPeer {
  readonly user: string; readonly doc: Y.Doc; readonly provider: HocuspocusProvider; readonly socket: HocuspocusProviderWebsocket;
  readonly closes: number[]; readonly failures: string[]; destroy(): void;
}
export function docPeer(page: string, user: string, role = 'member'): DocPeer {
  const doc = new Y.Doc();
  const closes: number[] = []; const failures: string[] = [];
  const socket = new HocuspocusProviderWebsocket({ url: WS_URL, WebSocketPolyfill: originSocket(ORIGIN) });
  const provider = new HocuspocusProvider({
    name: page, token: devToken(user, role), document: doc, websocketProvider: socket,
    onAuthenticationFailed: ({ reason }) => { failures.push(reason); },
    onClose: ({ event }) => { closes.push(event.code); },
  });
  provider.attach();
  return { user, doc, provider, socket, closes, failures, destroy: () => { provider.destroy(); socket.destroy(); } };
}
export const peerSynced = (p: DocPeer, timeoutMs = 20_000): Promise<void> => eventually(() => (p.provider.synced ? true : undefined), timeoutMs, `${p.user} synced`).then(() => undefined);

/** True when every document holds the same content (same state vector and same fragment). */
export function converged(docs: readonly Y.Doc[]): boolean {
  const [first, ...rest] = docs;
  if (first === undefined) return true;
  const vector = Y.encodeStateVector(first); const shape = first.getXmlFragment(FRAGMENT).toString();
  return rest.every((d) => d.getXmlFragment(FRAGMENT).toString() === shape && Buffer.compare(Buffer.from(Y.encodeStateVector(d)), Buffer.from(vector)) === 0);
}

/** The reference editor's Markdown over the state: the editor of the browser, bound to a fresh document holding exactly this state. */
export async function referenceMarkdown(doc: Y.Doc): Promise<string> {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const editor = await makeEditor({ ydoc: copy });
    try { return editor.markdown(); } finally { editor.destroy(); }
}

// ---- editing through a real editor ---------------------------------------------------------------------------------------------------

/** The only way the scenarios let clients type without having synced: `n` tokens into the client's own paragraph (see the rule on `EditorUser`). */
export function typeInOwnParagraph(user: EditorUser, n: number): void { for (let i = 0; i < n; i++) user.typeOwn(); }

export const TOKEN = /t[a-z]\d+n\d+e/g;

/**
 * One person typing into a real editor: whole tokens (`tb3n17e`: letters and digits only, so Markdown does not escape them and each is
 * findable) at token boundaries of a random text block, now and then a new paragraph (Enter), now and then the deletion of one token.
 * `typed` and `removed` are what this client did; the set of live tokens is what the other clients and the database must show.
 */
export class EditorUser {
  readonly peer: DocPeer;
  private editor: ReferenceEditor | undefined;
  private readonly tag: string; private readonly rng: Rng; private seq = 0; private readonly live: Set<string>;
  typed = 0; splits = 0; removed = 0; skipped = 0;
  constructor(peer: DocPeer, tag: string, rng: Rng, live: Set<string>) { this.peer = peer; this.tag = tag; this.rng = rng; this.live = live; }

  async open(): Promise<void> { this.editor = await makeEditor({ ydoc: this.peer.doc }); }
  close(): void { this.editor?.destroy(); this.editor = undefined; }

  /**
   * RULE (R3.27): a client's UNSYNCED typing (offline, or before the others have its edits) goes into the paragraph that starts with its own
   * marker (`Owna `, `Ownb `, ...), which no other client types in at that time. `editSettled` (a random edit anywhere, including a paragraph
   * split or the deletion of a token) is only called while every client is online and all hold the same state. Reason: y-prosemirror 1.3.7
   * interleaves letters typed at the same spot by two unsynced clients, and loses or doubles text when a split or delete meets another
   * client's edit in the same block (docs/proof/m2-live-save.md, the two known limits). Nothing is lost or doubled by the interleave, but a
   * typed token can come out split, which a content check cannot tell from a loss.
   */
  private act(own: boolean): void {
    const editor = this.editor;
    if (editor === undefined) throw new Error('editor not open');
    const view = editor.view();
    const structure = !own;
    const marker = `Own${this.tag} `;
    const blocks: { pos: number; text: string; type: string }[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.isTextblock) blocks.push({ pos, text: node.textContent, type: node.type.name });
      return !node.isTextblock;
    });
    const block = own ? blocks.find((b) => b.text.startsWith(marker)) : blocks[Math.floor(this.rng() * blocks.length)];
    if (block === undefined) { if (own) throw new Error(`no paragraph of ${marker.trim()}`); this.skipped += 1; return; }
    const floor = /^Own[a-z] /.exec(block.text)?.[0].length ?? 0; // never edit the marker itself
    const inside = [...block.text.matchAll(TOKEN)].map((m) => [m.index, m.index + m[0].length] as const);
    const offset = floor + Math.floor(this.rng() * (block.text.length - floor + 1));
    const caret = inside.find(([from, to]) => offset > from && offset < to)?.[0] ?? offset; // never inside a token: a person's caret is between typed units
    const at = block.pos + 1 + caret;
    const roll = this.rng();
    const tr = view.state.tr;
    const whole = [...block.text.matchAll(TOKEN)];
    if (structure && roll < 0.45 && whole.length > 0) {
      const m = whole[Math.floor(this.rng() * whole.length)];
      if (m !== undefined) {
        view.dispatch(tr.delete(block.pos + 1 + m.index, block.pos + 1 + m.index + m[0].length));
        this.live.delete(m[0]); this.removed += 1; return;
      }
    }
    if (structure && roll < 0.9 && (block.type === 'paragraph' || block.type === 'heading') && caret > floor) {
      view.dispatch(tr.split(at)); this.splits += 1; return;
    }
    const token = `t${this.tag}${String(this.seq)}n${String(this.typed)}e`;
    this.seq += 1;
    // Harness mutation (M2_DROP_EDIT=<n>): the n-th token typed by each client is counted as typed but never reaches the document, as a client that loses an edit would.
    if (String(this.typed) !== process.env['M2_DROP_EDIT']) view.dispatch(tr.insertText(token, at));
    this.live.add(token); this.typed += 1;
  }

  /** A random edit anywhere, restructuring included: only while every client is online and all hold the same state. */
  editSettled(): void { this.act(false); }
  /** Types one token into this client's own paragraph. */
  typeOwn(): void { this.act(true); }

  /** Types and deletes two letters at the end of the first text block: the Markdown does not change, the state does. */
  touch(): void {
    const editor = this.editor;
    if (editor === undefined) throw new Error('editor not open');
    const view = editor.view();
    let end = -1;
    view.state.doc.descendants((node, pos) => { if (end < 0 && node.type.name === 'paragraph') end = pos + 1 + node.content.size; return end < 0; });
    if (end < 0) throw new Error('no paragraph');
    view.dispatch(view.state.tr.insertText('zz', end));
  }
  untouch(): void {
    const editor = this.editor;
    if (editor === undefined) throw new Error('editor not open');
    const view = editor.view();
    let end = -1;
    view.state.doc.descendants((node, pos) => { if (end < 0 && node.type.name === 'paragraph') end = pos + 1 + node.content.size; return end < 0; });
    view.dispatch(view.state.tr.delete(end - 2, end));
  }
}

// ---- the stack ---------------------------------------------------------------------------------------------------------------------

/** Recreates the app container with the given settings (the way ../mutation.ts does) and waits until it answers. */
export async function recreateApp(env: Record<string, string>): Promise<void> {
  await exec('docker', ['compose', '-p', 'grimoire', 'up', '-d', '--force-recreate', '--no-deps', '--wait', 'app'], { cwd: repoRoot, env: { ...process.env, ...env } });
  await waitReady();
}
export const alive = async (): Promise<boolean> => { try { return (await fetch(`${BASE}/readyz`)).ok; } catch { return false; } };

// ---- a second client's round trips ---------------------------------------------------------------------------------------------------

/**
 * Measures how fast the server answers a second client while it works: every 10 ms it sends a sync step 1 for its own small page and
 * times the reply. Reason it is hand-built: Node's global WebSocket cannot send a protocol ping, and this round trip goes through the same
 * event loop that answers a ping (the pool exists to keep that loop free).
 */
export class Pinger {
  private readonly socket: WebSocket; private readonly page: string;
  private sentAt = 0; private timer: NodeJS.Timeout | undefined; private authed = false;
  readonly samples: number[] = [];
  private constructor(socket: WebSocket, page: string) {
    this.socket = socket; this.page = page;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', () => {
      if (!this.authed) { this.authed = true; return; }
      if (this.sentAt > 0) { this.samples.push(performance.now() - this.sentAt); this.sentAt = 0; }
    });
  }
  static async open(page: string, token: string): Promise<Pinger> {
    const socket = new (originSocket(ORIGIN))(WS_URL);
    const p = new Pinger(socket, page);
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => { resolve(); }); socket.addEventListener('error', () => { reject(new Error('ping socket error')); }); });
    const auth = encoding.createEncoder();
    encoding.writeVarString(auth, page); encoding.writeVarUint(auth, 2); encoding.writeVarUint(auth, 0); encoding.writeVarString(auth, token);
    socket.send(Uint8Array.from(encoding.toUint8Array(auth)));
    await eventually(() => (p.authed ? true : undefined), 10_000, 'the ping client to authenticate');
    return p;
  }
  /** Starts timing; returns a function that stops and gives the samples taken since. */
  start(): () => { max: number; count: number } {
    this.samples.length = 0;
    const doc = new Y.Doc(); const vector = Y.encodeStateVector(doc);
    this.timer = setInterval(() => {
      if (this.sentAt > 0 || this.socket.readyState !== WebSocket.OPEN) return;
      const e = encoding.createEncoder();
      encoding.writeVarString(e, this.page); encoding.writeVarUint(e, 0); encoding.writeVarUint(e, 0); encoding.writeVarUint8Array(e, vector);
      this.sentAt = performance.now();
      this.socket.send(Uint8Array.from(encoding.toUint8Array(e)));
    }, 10);
    return () => {
      clearInterval(this.timer);
      // A request still waiting when the window ends counts with the time it has waited.
      const open = this.sentAt > 0 ? [performance.now() - this.sentAt] : [];
      const all = [...this.samples, ...open];
      return { max: all.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...all), count: all.length };
    };
  }
  close(): void { clearInterval(this.timer); this.socket.close(); }
}
