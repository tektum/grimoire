import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { FRAGMENT_NAME } from '@tektum/grimoire-editor-schema';
import { createHeadless, getHeadless } from '../headless.js';
import type { Headless } from '../headless.js';
import { seedInProcess } from '../seed.js';

/** Test helpers: build Yjs states the way the editor would, and hostile ones the editor never would. */

export async function headlessForTests(): Promise<Headless> {
  return createHeadless();
}

/** The pre-check limits lifted, so a test can build a state of any size the converter itself accepts. */
const UNBOUNDED_PRECHECK = { maxSeedMarkdownBytes: 64 * 1024 * 1024, maxSeedLines: 100_000_000, maxSeedLineMarkers: 100_000 } as const;

/** Markdown to a Yjs update, through the seeding path with the pre-check lifted. Throws on failure (tests only). */
export async function stateFromMarkdown(markdown: string): Promise<Uint8Array> {
  const seeded = await seedInProcess(markdown, UNBOUNDED_PRECHECK);
  if (!seeded.ok) throw new Error(`seed failed: ${seeded.reason}: ${seeded.detail}`);
  return seeded.state;
}

/** Markdown to a Yjs update through the headless parser and y-prosemirror directly (not through `seedInProcess`). */
export async function stateFromMarkdownDirect(markdown: string, clientID = 3_000_000_001): Promise<Uint8Array> {
  const headless = await createHeadless();
  const doc = new Y.Doc();
  doc.clientID = clientID;
  prosemirrorToYXmlFragment(headless.parse(markdown), doc.getXmlFragment(FRAGMENT_NAME));
  return Y.encodeStateAsUpdate(doc);
}

/** A document built by hand: `build` receives the fragment of a fresh doc. */
export function stateFromFragment(build: (fragment: Y.XmlFragment, doc: Y.Doc) => void, name = FRAGMENT_NAME): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 3_000_000_002;
  build(doc.getXmlFragment(name), doc);
  return Y.encodeStateAsUpdate(doc);
}

export function paragraphWith(text: string, attrs: Record<string, unknown> = {}): Y.XmlElement {
  const paragraph = new Y.XmlElement('paragraph');
  for (const [key, value] of Object.entries(attrs)) paragraph.setAttribute(key, value as string);
  paragraph.insert(0, [new Y.XmlText(text)]);
  return paragraph;
}

/** Wrap one paragraph in `levels` nested elements of `name`, built iteratively (a recursive build would overflow). */
export function nestedState(name: string, levels: number, text = 'deep'): Uint8Array {
  return stateFromFragment((fragment, doc) => {
    let parent: Y.XmlFragment | Y.XmlElement = fragment;
    doc.transact(() => {
      for (let level = 0; level < levels; level += 1) {
        const element = new Y.XmlElement(name);
        parent.insert(0, [element]);
        parent = element;
      }
      parent.insert(0, [paragraphWith(text)]);
    });
  });
}

/** Alternating list and list item nesting: `lists` bullet lists, each inside a list item of the one above. */
export function nestedListState(lists: number): Uint8Array {
  return stateFromFragment((fragment, doc) => {
    let parent: Y.XmlFragment | Y.XmlElement = fragment;
    doc.transact(() => {
      for (let level = 0; level < lists; level += 1) {
        const list = new Y.XmlElement('bullet_list');
        const item = new Y.XmlElement('list_item');
        parent.insert(0, [list]);
        list.insert(0, [item]);
        parent = item;
      }
      parent.insert(0, [paragraphWith('x')]);
    });
  });
}

/** `count` empty-ish paragraphs, each with one character. */
export function manyParagraphsState(count: number): Uint8Array {
  return stateFromFragment((fragment, doc) => {
    doc.transact(() => {
      const items: Y.XmlElement[] = [];
      for (let i = 0; i < count; i += 1) items.push(paragraphWith('x'));
      fragment.insert(0, items);
    });
  });
}

/** A tight bullet list whose one item is an empty paragraph followed by `second`: what an editor makes of an emptied item. */
export function emptyItemThen(second: () => Y.XmlElement): Uint8Array {
  return stateFromFragment((fragment, doc) => {
    doc.transact(() => {
      const list = new Y.XmlElement('bullet_list');
      list.setAttribute('spread', false as unknown as string);
      const item = new Y.XmlElement('list_item');
      item.setAttribute('listType', 'bullet');
      item.setAttribute('label', '\u2022');
      item.setAttribute('spread', false as unknown as string);
      fragment.insert(0, [list]);
      list.insert(0, [item]);
      item.insert(0, [new Y.XmlElement('paragraph'), second()]);
    });
  });
}

export function codeBlockWith(text: string, language = 'ts'): Y.XmlElement {
  const block = new Y.XmlElement('code_block');
  block.setAttribute('language', language);
  block.insert(0, [new Y.XmlText(text)]);
  return block;
}

export function bulletListWith(text: string): Y.XmlElement {
  const list = new Y.XmlElement('bullet_list');
  list.setAttribute('spread', false as unknown as string);
  const item = new Y.XmlElement('list_item');
  item.setAttribute('listType', 'bullet');
  item.setAttribute('label', '\u2022');
  item.setAttribute('spread', false as unknown as string);
  list.insert(0, [item]);
  item.insert(0, [paragraphWith(text)]);
  return list;
}

/** A Yjs update for a document given as ProseMirror JSON, written by y-prosemirror as the editor's collab plugin does. */
export async function stateFromDocJson(json: unknown): Promise<Uint8Array> {
  const headless = await getHeadless();
  const doc = new Y.Doc();
  doc.clientID = 3_000_000_003;
  prosemirrorToYXmlFragment(headless.schema.nodeFromJSON(json), doc.getXmlFragment(FRAGMENT_NAME));
  return Y.encodeStateAsUpdate(doc);
}
