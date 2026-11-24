import type { Page } from '@playwright/test';

/** One top-level block of the shared document, as the editor's document holds it. */
export interface Block {
  readonly name: string;
  /** The heading level (0 for none), as stored on the element. */
  readonly level: number;
  readonly text: string;
  /** The identity of the Yjs element (client and clock): the same element keeps it through any change of its attributes or text. */
  readonly id: string;
}

/**
 * The top-level blocks of the open page's shared document (the test build puts the document on `window.__grimoireDoc`). Reading it says what the editor did to the
 * document, which the look of the page cannot: a block that was replaced by a new one has another id.
 */
export async function blocks(page: Page): Promise<Block[]> {
  return page.evaluate(() => {
    const doc = (window as unknown as { __grimoireDoc?: import('yjs').Doc }).__grimoireDoc;
    if (doc === undefined) throw new Error('the page does not expose its document: the end-to-end build is needed');
    return doc
      .getXmlFragment('prosemirror')
      .toArray()
      .map((node) => {
        const element = node as import('yjs').XmlElement;
        const level = Number(element.getAttribute?.('level') ?? 0);
        const item = (element as unknown as { _item?: { id: { client: number; clock: number } } })._item;
        return { name: element.nodeName, level: Number.isFinite(level) ? level : 0, text: element.toDOM().textContent ?? '', id: item === undefined ? '' : `${item.id.client}:${item.id.clock}` };
      });
  });
}

/** The editing surface of a page. */
export const surface = (page: Page) => page.locator('.ProseMirror');

/**
 * The blocks other people's cursors are in, as this tab's awareness has them: `blockId` of every other client that has one, with the person's user id. The ids are those
 * of `blocks()`, so a spec can wait for "Bob is in the block with this id" before it acts.
 */
export async function remoteBlocks(page: Page): Promise<{ user: string; blockId: string }[]> {
  return page.evaluate(() => {
    const awareness = (window as unknown as { __grimoireAwareness?: { clientID: number; getStates(): Map<number, Record<string, unknown>> } }).__grimoireAwareness;
    if (awareness === undefined) throw new Error('the page does not expose its awareness: the end-to-end build is needed');
    const found: { user: string; blockId: string }[] = [];
    for (const [client, state] of awareness.getStates()) {
      const user = (state['user'] as { id?: string } | undefined)?.id;
      if (client !== awareness.clientID && typeof state['blockId'] === 'string' && typeof user === 'string') found.push({ user, blockId: state['blockId'] });
    }
    return found;
  });
}

/** The words of R3.15, as the "Why?" of the lock message says them. */
export const SOFT_LOCK_HELP =
  "While someone else's cursor is in a block, turning that block into a list, a quote or a code block waits until they leave it, so that what they are typing is not lost. This works only while you are both connected: if you edit offline, or two people act within a fraction of a second, text can still be lost.";

/** The first-version limit text of the contracts' section 7a (R3.26 and R3.27), exactly. */
export const LIMIT_TEXT =
  "Two people changing the structure of the same paragraph at the same moment (splitting it, joining it with the one above, or turning it into a list) can still lose or repeat a few words, because one person's change reaches the other after a short delay. If you worked offline and the document was restructured meanwhile, keep a separate copy of your edits before reconnecting. Separately, if two people type several letters at exactly the same spot at the same moment, their letters can end up mixed together; nothing is lost, but the words may need retyping, and seeing the other person's cursor on the same spot is the sign to wait. The structure lock and the automatic copy offer are planned after the first version.";
