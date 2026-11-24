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
