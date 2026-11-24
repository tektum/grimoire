import { TextSelection } from '@milkdown/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { slashQuery } from '../../src/editor/menus/slash';
import { plainEditor } from './support';

type Editor = Awaited<ReturnType<typeof plainEditor>>;
let current: Editor | null = null;
afterEach(async () => {
  await current?.destroy();
  current = null;
});

const typeText = (t: Editor, text: string): void => {
  const view = t.view();
  view.dispatch(view.state.tr.insertText(text, view.state.selection.from));
};
const press = (t: Editor, key: string): void => void t.view().dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const host = (t: Editor): HTMLElement => t.element.querySelector<HTMLElement>('.slash-host')!;
const open = (t: Editor): boolean => host(t)?.dataset['show'] === 'true';
const options = (t: Editor): string[] => Array.from(host(t).querySelectorAll('[role=option] .slash-label')).map((node) => node.textContent ?? '');

async function emptyParagraph(): Promise<Editor> {
  current = await plainEditor('Some words');
  const t = current;
  const view = t.view();
  t.cursorAtEnd();
  view.dispatch(view.state.tr.split(view.state.selection.from)); // a new, empty paragraph below, with the cursor in it
  return t;
}

describe('what is typed after the slash', () => {
  it('is read only from a paragraph that starts with the slash, with the cursor at the end of the word', async () => {
    const t = await emptyParagraph();
    expect(slashQuery(t.view())).toBeNull();
    typeText(t, '/');
    expect(slashQuery(t.view())).toBe('');
    typeText(t, 'qu');
    expect(slashQuery(t.view())).toBe('qu');
    typeText(t, ' x');
    expect(slashQuery(t.view())).toBeNull(); // a space ends it
  });

  it('is nothing for a slash after other text, for a range and for a document that cannot be edited', async () => {
    const t = await emptyParagraph();
    typeText(t, 'a /');
    expect(slashQuery(t.view())).toBeNull();
    const view = t.view();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 4)));
    expect(slashQuery(view)).toBeNull();
    const readOnly = await plainEditor('/x', { editable: false });
    try {
      readOnly.cursorAtEnd();
      expect(slashQuery(readOnly.view())).toBeNull();
    } finally {
      await readOnly.destroy();
    }
  });
});

describe('the menu in the editor', () => {
  it('opens on a slash at the start of a paragraph with every kind, points the editor at the active one, and narrows as the person types', async () => {
    const t = await emptyParagraph();
    typeText(t, '/');
    await vi.waitFor(() => expect(open(t)).toBe(true));
    expect(options(t)).toHaveLength(14);
    expect(t.view().dom.getAttribute('aria-activedescendant')).toBe('slash-option-text');
    expect(t.view().dom.getAttribute('aria-controls')).toBe('slash-menu');
    typeText(t, 'head');
    await vi.waitFor(() => expect(options(t)).toHaveLength(6));
    typeText(t, 'zz');
    await vi.waitFor(() => expect(host(t).textContent).toContain('No block matches'));
  });

  it('closes when the slash is gone', async () => {
    const t = await emptyParagraph();
    typeText(t, '/');
    await vi.waitFor(() => expect(open(t)).toBe(true));
    const view = t.view();
    view.dispatch(view.state.tr.delete(view.state.selection.from - 1, view.state.selection.from));
    await vi.waitFor(() => expect(open(t)).toBe(false));
    expect(view.dom.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('arrow keys move the active item, wrapping round; Enter chooses it: the slash text goes and the block is that kind', async () => {
    const t = await emptyParagraph();
    typeText(t, '/head');
    await vi.waitFor(() => expect(options(t)).toHaveLength(6));
    press(t, 'ArrowDown');
    expect(t.view().dom.getAttribute('aria-activedescendant')).toBe('slash-option-heading-2');
    press(t, 'ArrowUp');
    press(t, 'ArrowUp');
    expect(t.view().dom.getAttribute('aria-activedescendant')).toBe('slash-option-heading-6'); // up from the first wraps to the last
    press(t, 'ArrowDown');
    press(t, 'ArrowDown');
    press(t, 'Enter');
    expect(t.view().state.doc.lastChild?.attrs['level']).toBe(2); // the block is the heading, level 2, and no slash text is left in it
    expect(t.view().state.doc.lastChild?.textContent).toBe('');
    await vi.waitFor(() => expect(open(t)).toBe(false));
  });

  it('scrolls the item that becomes active into view, not the one that was: up from the first item wraps to the last and shows it', async () => {
    const t = await emptyParagraph();
    typeText(t, '/');
    await vi.waitFor(() => expect(open(t)).toBe(true));
    const shown: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      shown.push(this.id);
    };
    try {
      press(t, 'ArrowUp');
      press(t, 'ArrowDown');
      press(t, 'ArrowDown');
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    expect(shown).toEqual(['slash-option-table', 'slash-option-text', 'slash-option-heading-1']);
  });

  it('moving the pointer over an item makes it the active one', async () => {
    const t = await emptyParagraph();
    typeText(t, '/');
    await vi.waitFor(() => expect(open(t)).toBe(true));
    host(t)
      .querySelector('#slash-option-quote')!
      .dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    await vi.waitFor(() => expect(t.view().dom.getAttribute('aria-activedescendant')).toBe('slash-option-quote'));
  });

  it('Tab chooses too, and a click on an item chooses that one', async () => {
    const t = await emptyParagraph();
    typeText(t, '/quote');
    await vi.waitFor(() => expect(options(t)).toEqual(['Quote']));
    press(t, 'Tab');
    expect(t.markdown()).toContain('>');
    await t.destroy();
    current = null;
    const second = await emptyParagraph();
    typeText(second, '/divider');
    await vi.waitFor(() => expect(options(second)).toEqual(['Divider']));
    host(second)
      .querySelector('[role=option]')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(second.markdown()).toMatch(/^(---|\*\*\*|___)$/m);
  });

  it("Escape closes it, and it stays closed until the text changes; keys other than its own are the editor's", async () => {
    const t = await emptyParagraph();
    typeText(t, '/q');
    await vi.waitFor(() => expect(open(t)).toBe(true));
    press(t, 'Escape');
    expect(open(t)).toBe(false);
    typeText(t, 'u');
    await vi.waitFor(() => expect(open(t)).toBe(true));
    const other = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    t.view().dom.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it('does not touch the keys when it is closed: Enter makes a new paragraph as usual', async () => {
    const t = await emptyParagraph();
    typeText(t, 'plain');
    const before = t.view().state.doc.childCount;
    press(t, 'Enter');
    expect(t.view().state.doc.childCount).toBe(before + 1); // the key reached the editor, which made the new paragraph
    expect(open(t)).toBe(false);
  });

  it('puts the typed text back when the schema refuses the kind where the cursor is: the first block of a table cell cannot be a heading', async () => {
    current = await plainEditor('| Head | Other |\n| --- | --- |\n| cell | more |\n');
    const t = current;
    const view = t.view();
    let cell = -1;
    view.state.doc.descendants((node, pos) => {
      if (cell < 0 && node.type.name === 'table_cell' && node.textContent === 'cell') cell = pos;
    });
    expect(cell).toBeGreaterThan(0);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cell + 2))); // at the start of the paragraph in the cell
    view.dispatch(view.state.tr.insertText('/head', cell + 2));
    await vi.waitFor(() => expect(open(t)).toBe(true));
    expect(options(t)).toHaveLength(6);
    press(t, 'Enter');
    const after = view.state.doc.nodeAt(cell)!;
    expect(after.textContent).toBe('/headcell'); // nothing lost, nothing misplaced
    expect(after.firstChild?.type.name).toBe('paragraph');
    expect(after.firstChild?.attrs['level']).toBe(0); // and still a paragraph: the schema refused
  });

  it('Escape keeps it closed until the text after the slash changes, or the cursor has left the slash: delete the slash and type it again, and it opens', async () => {
    const t = await emptyParagraph();
    typeText(t, '/');
    await vi.waitFor(() => expect(open(t)).toBe(true));
    press(t, 'Escape');
    const view = t.view();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.selection.from))); // a move of the cursor that changes nothing
    expect(open(t)).toBe(false);
    view.dispatch(view.state.tr.delete(view.state.selection.from - 1, view.state.selection.from));
    typeText(t, '/');
    await vi.waitFor(() => expect(open(t)).toBe(true));
  });
});

describe('the slash menu in an editor that cannot be edited', () => {
  it('is never shown', async () => {
    const t = await plainEditor('Some words', { editable: false });
    try {
      t.cursorAtEnd();
      typeText(t, '/');
      expect(slashQuery(t.view())).toBeNull();
      // The library has looked at the update and decided to hide (that is what sets the attribute): only then is "not shown" a result and not just an early look.
      await vi.waitFor(() => expect(host(t)?.getAttribute('data-show')).toBe('false'), { timeout: 3000 });
    } finally {
      await t.destroy();
    }
  });
});
