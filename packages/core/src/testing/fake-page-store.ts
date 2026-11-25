import { createHash } from 'node:crypto';
import type { PageStore, PageWrite, StoredPage, WriteOutcome } from '../ports/collaboration-host.js';

/** The fake has no titles: its hash is the real rule (SHA-256 of title, NUL, Markdown) for the empty title. */
const hashOf = (markdown: string): Uint8Array => new Uint8Array(createHash('sha256').update('\0').update(markdown, 'utf8').digest());

/** In-memory PageStore for tests (the port fake lives with the others in the core). `rows` holds the state of each row (`null`: no state yet); `markdowns`, `texts`, `hashes`, `editors` the other columns. `failStores` makes `store` reject. */
export class FakePageStore implements PageStore {
  readonly rows = new Map<string, Uint8Array | null>();
  readonly markdowns = new Map<string, string | null>();
  readonly texts = new Map<string, string | null>();
  readonly hashes = new Map<string, Uint8Array | null>();
  readonly editors = new Map<string, string | undefined>();
  readonly stale = new Map<string, number | null>();
  readonly writes: PageWrite[] = [];
  readonly calls = { load: 0, store: 0 };
  seedCalls = 0;
  epoch = 0;
  failStores = false;
  failLoads = false;

  /** Creates a row (test setup), or, with a function, seeds one like `PageStore.seed`. */
  seed(id: string, state?: Uint8Array | null): void;
  seed(id: string, build: (markdown: string) => Promise<Uint8Array>): Promise<{ state: Uint8Array | null; seeded: boolean; epoch: number }>;
  seed(id: string, arg?: Uint8Array | null | ((markdown: string) => Promise<Uint8Array>)): void | Promise<{ state: Uint8Array | null; seeded: boolean; epoch: number }> {
    if (typeof arg !== 'function') {
      this.rows.set(id, arg ?? null);
      if (!this.markdowns.has(id)) this.markdowns.set(id, null);
      return undefined;
    }
    return this.seedRow(id, arg);
  }

  private async seedRow(id: string, build: (markdown: string) => Promise<Uint8Array>): Promise<{ state: Uint8Array | null; seeded: boolean; epoch: number }> {
    this.seedCalls++;
    const state = this.rows.get(id) ?? null;
    if (state !== null) return { state, seeded: false, epoch: this.epoch };
    const markdown = this.markdowns.get(id) ?? null;
    if (markdown === null || markdown === '') return { state: null, seeded: false, epoch: this.epoch };
    const built = await build(markdown);
    this.rows.set(id, built);
    return { state: built, seeded: true, epoch: this.epoch };
  }

  listStale(limit: number): Promise<string[]> {
    return Promise.resolve([...this.stale].filter(([, v]) => v !== null).sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0)).slice(0, limit).map(([id]) => id));
  }

  repairMarkdown(id: string, seen: { readonly state: Uint8Array; readonly epoch: number }, converted: { readonly markdown: string; readonly text: string }): Promise<'repaired' | 'skipped'> {
    const have = this.rows.get(id);
    if (!have || seen.epoch !== this.epoch || !Buffer.from(have).equals(Buffer.from(seen.state)) || (this.stale.get(id) ?? null) === null) return Promise.resolve('skipped');
    this.markdowns.set(id, converted.markdown);
    this.texts.set(id, converted.text);
    this.hashes.set(id, hashOf(converted.markdown));
    this.stale.set(id, null);
    return Promise.resolve('repaired');
  }

  load(id: string): Promise<StoredPage | undefined> {
    this.calls.load++;
    if (this.failLoads) return Promise.reject(new Error('load failed'));
    const state = this.rows.get(id);
    if (state === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ state, markdown: this.markdowns.get(id) ?? null, markdownHash: this.hashes.get(id) ?? null, epoch: this.epoch, markdownStaleSince: this.stale.get(id) ?? null });
  }

  store(id: string, w: PageWrite): Promise<WriteOutcome> {
    this.calls.store++;
    if (this.failStores) return Promise.reject(new Error('store failed'));
    if (!this.rows.has(id)) return Promise.resolve({ written: false, reason: 'no-row' });
    if (w.epoch !== this.epoch) return Promise.resolve({ written: false, reason: 'epoch-mismatch' });
    if (w.kind === 'converted') {
      const old = this.hashes.get(id);
      const markdownHash = hashOf(w.markdown);
      if ((this.stale.get(id) ?? null) === null && old && Buffer.from(old).equals(Buffer.from(markdownHash))) {
        const have = this.rows.get(id);
        if (have && Buffer.from(have).equals(Buffer.from(w.state))) return Promise.resolve({ written: false, reason: 'unchanged' });
        this.rows.set(id, w.state); // same Markdown, newer state: only the state (and the editor) is written
        if (w.editedBy !== undefined) this.editors.set(id, w.editedBy);
        this.writes.push(w);
        return Promise.resolve({ written: true });
      }
      this.markdowns.set(id, w.markdown);
      this.texts.set(id, w.text);
      this.hashes.set(id, markdownHash);
      if (w.editedBy !== undefined) this.editors.set(id, w.editedBy); // as the store does (coalesce): a save without an editor keeps the earlier one
      this.stale.set(id, null);
    } else if ((this.stale.get(id) ?? null) === null) {
      this.stale.set(id, Date.now());
    }
    this.rows.set(id, w.state);
    this.writes.push(w);
    return Promise.resolve({ written: true });
  }
}
