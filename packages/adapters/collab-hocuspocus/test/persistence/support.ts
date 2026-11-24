import type { ConvertResult, MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import * as Y from 'yjs';
import { createPersistenceExtension } from '../../src/extensions/persistence.js';
import type { PersistenceOptions } from '../../src/extensions/persistence.js';
import { makeDeps, PAGE } from '../host/support.js';

export { PAGE };
export const ALICE = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';

/** The Markdown of a test document is its text, so each edit gives a new Markdown. */
export const textOf = (state: Uint8Array): string => { const d = new Y.Doc(); Y.applyUpdate(d, state); return d.getText('prosemirror').toString(); };
export const okOf = (state: Uint8Array): ConvertResult => ({ ok: true, markdown: textOf(state), text: textOf(state).toLowerCase() });

/** A persistence extension on fakes. `sleep` waits for `release()`, so "convert later" timers fire when the test says. */
export function setup(options: Partial<PersistenceOptions> = {}, role: 'member' = 'member', converterOverride?: MarkdownConverter) {
  const t = makeDeps(role);
  t.pages.seed(PAGE);
  const waits: { ms: number; release: () => void }[] = [];
  // Typed as the fake: the tests that read its scripts and counters (`convertCalls`, `enqueueConvert`) never pass their own converter.
  const converter = (converterOverride ?? new FakeMarkdownConverter({ convert: okOf })) as FakeMarkdownConverter;
  const deps = { ...t.deps, converter };
  const ext = createPersistenceExtension({
    deps, log: t.log,
    sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
      waits.push({ ms, release: resolve });
      signal.addEventListener('abort', () => { reject(new Error('aborted')); });
    }),
    ...options,
  });
  const doc = new Y.Doc();
  const edit = async (text: string, userId?: string): Promise<void> => {
    doc.getText('prosemirror').insert(0, text);
    await ext.onChange?.({ documentName: PAGE, context: userId === undefined ? {} : { userId } } as never);
  };
  const store = () => ext.onStoreDocument?.({ document: doc, documentName: PAGE } as never) ?? Promise.resolve();
  const events = (name: string) => t.logger.entries.filter((e) => e.event === name);
  const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
  return { ...t, deps, converter, ext, doc, edit, store, events, waits, flush };
}

/** What the real seed produces: a paragraph in the `prosemirror` fragment under the converter's fixed client id. */
export function seedDoc(text: string): Y.Doc {
  const d = new Y.Doc(); d.clientID = 3_000_000_000;
  const p = new Y.XmlElement('paragraph'); const t = new Y.XmlText(); t.insert(0, text); p.insert(0, [t]);
  d.getXmlFragment('prosemirror').insert(0, [p]);
  return d;
}
