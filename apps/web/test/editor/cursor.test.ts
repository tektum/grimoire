import { afterEach, describe, expect, it } from 'vitest';
import { LABEL_MS, TOP_BAR_PX, cursorBuilders } from '../../src/editor/core/cursor';
import { UNKNOWN_NAME, type Directory } from '../../src/editor/core/directory';
import { COLLAB_COLOURS, caretColour, colourIndex, labelText } from '../../src/ui/collab';
import { FakeClock } from './support';

const ID = '00000000-0000-4000-8000-000000000001';

const fakeDirectory = (names: Record<string, string> = {}) => {
  const listeners = new Set<() => void>();
  const requested: string[] = [];
  const directory: Directory = {
    nameOf: (id) => names[id] ?? UNKNOWN_NAME,
    request: (ids) => void requested.push(...ids),
    subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)),
  };
  return { directory, requested, arrive: (id: string, name: string) => ((names[id] = name), listeners.forEach((l) => l())) };
};

const make = (names: Record<string, string> = {}) => {
  const clock = new FakeClock();
  const dir = fakeDirectory(names);
  return { clock, ...dir, builders: cursorBuilders(dir.directory, { setTimeout: (fn, ms) => clock.after(fn, ms) }) };
};

describe('the remote cursor', () => {
  it('is a caret in the colour derived from the id, with the directory name as its label', () => {
    const { builders, requested } = make({ [ID]: 'Ada' });
    const caret = builders.cursorBuilder({ id: ID });
    const colour = COLLAB_COLOURS[colourIndex(ID)]!;
    expect(caret.classList.contains('ProseMirror-yjs-cursor')).toBe(true);
    expect(caret.dataset.userId).toBe(ID);
    expect(caret.style.getPropertyValue('--cursor')).toBe(colour);
    // The caret line takes the theme's caret colour (3:1 on the paper); the flag keeps the fixed colour.
    expect(caret.style.getPropertyValue('--cursor-caret')).toBe(caretColour(colourIndex(ID)));
    expect(caret.style.getPropertyValue('--cursor-text')).toBe(labelText(colour));
    expect(caret.querySelector('.cursor-label')!.textContent).toBe('Ada');
    expect(requested).toEqual([ID]);
  });

  it('shows "Someone" for a person the directory does not know, and the name once it arrives', () => {
    const { builders, arrive } = make();
    document.body.append(builders.cursorBuilder({ id: ID }));
    const label = document.querySelector('.cursor-label')!;
    expect(label.textContent).toBe('Someone');
    arrive(ID, 'Ada');
    expect(label.textContent).toBe('Ada');
    label.remove();
  });

  it('ignores a name and a colour that the peer published: nothing but the id is read, and "Forged" is nowhere', () => {
    const { builders } = make({ [ID]: 'Ada' });
    const caret = builders.cursorBuilder({ id: ID, name: 'Forged', color: '#ff0000' });
    const selection = builders.selectionBuilder({ id: ID, name: 'Forged', color: '#ff0000' });
    expect(caret.outerHTML).not.toContain('Forged');
    expect(caret.outerHTML.toLowerCase()).not.toContain('#ff0000');
    expect(caret.outerHTML.toLowerCase()).not.toContain('rgb(255, 0, 0)');
    expect(JSON.stringify(selection)).not.toContain('Forged');
    expect(selection.style).not.toContain('ff0000');
  });

  it('takes the label as text: a name with markup in it is shown as that text', () => {
    for (const name of ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '"><svg onload=alert(1)>']) {
      const { builders } = make({ [ID]: name });
      const caret = builders.cursorBuilder({ id: ID });
      expect(caret.querySelector('.cursor-label')!.children).toHaveLength(0);
      expect(caret.querySelector('.cursor-label')!.textContent).toBe(name);
      expect(caret.querySelector('img, script, svg')).toBeNull();
    }
  });

  it('shows the label on arrival and for 2 seconds, then hides it and leaves the caret as a dot', async () => {
    const { clock, builders } = make({ [ID]: 'Ada' });
    const caret = builders.cursorBuilder({ id: ID });
    const label = caret.querySelector('.cursor-label')!;
    expect(label.classList.contains('cursor-label--shown')).toBe(true);
    expect(caret.classList.contains('cursor--dot')).toBe(false);
    await clock.advance(LABEL_MS - 1);
    expect(label.classList.contains('cursor-label--shown')).toBe(true);
    expect(caret.classList.contains('cursor--dot')).toBe(false);
    await clock.advance(1);
    expect(label.classList.contains('cursor-label--shown')).toBe(false);
    expect(caret.classList.contains('cursor--dot')).toBe(true);
    expect(LABEL_MS).toBe(2000);
  });

  it('is still a cursor, with some colour and "Someone", when the peer published no id', () => {
    const { builders, requested } = make();
    for (const user of [undefined, null, {}, { id: 5 }, 'x']) {
      const caret = builders.cursorBuilder(user);
      expect(caret.querySelector('.cursor-label')!.textContent).toBe('Someone');
      expect(COLLAB_COLOURS).toContain(caret.style.getPropertyValue('--cursor') as never);
      expect(caret.hasAttribute('data-user-id')).toBe(false);
    }
    expect(requested).toEqual([]);
  });

  it("draws a selection with the person's colour at 18%", () => {
    const { builders } = make();
    const colour = COLLAB_COLOURS[colourIndex(ID)]!;
    expect(builders.selectionBuilder({ id: ID })).toEqual({ class: 'ProseMirror-yjs-selection', style: `background-color: ${colour}2e` });
    expect(Math.round((0x2e / 0xff) * 100)).toBe(18);
    // A peer that published no id still gets a tint, of the colour of the empty id.
    expect(builders.selectionBuilder({}).style).toBe(`background-color: ${COLLAB_COLOURS[colourIndex('')]!}2e`);
  });

  it('gives two people different colours when their ids hash apart, and the same person the same colour every time', () => {
    const { builders } = make();
    const a = builders.cursorBuilder({ id: ID }).style.getPropertyValue('--cursor');
    expect(builders.cursorBuilder({ id: ID }).style.getPropertyValue('--cursor')).toBe(a);
    const others = new Set(Array.from({ length: 40 }, (_, i) => builders.cursorBuilder({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }).style.getPropertyValue('--cursor')));
    expect(others.size).toBeGreaterThan(3);
  });

  it('uses the platform timer when none is given', () => {
    const { directory } = fakeDirectory();
    const caret = cursorBuilders(directory).cursorBuilder({ id: ID });
    expect(caret.querySelector('.cursor-label--shown')).not.toBeNull();
  });

  it('lets go of the labels of carets that were replaced, once the render is done: following does not grow with every move of a remote cursor', async () => {
    const { builders } = make({ [ID]: 'Ada' });
    for (let move = 0; move < 200; move++) {
      const caret = builders.cursorBuilder({ id: ID });
      document.body.append(caret);
      document.querySelectorAll('.ProseMirror-yjs-cursor').forEach((old) => old !== caret && old.remove()); // the plugin drops the old caret
      await Promise.resolve();
    }
    await Promise.resolve();
    expect(builders.tracked()).toBeLessThanOrEqual(2);
    document.querySelectorAll('.ProseMirror-yjs-cursor').forEach((el) => el.remove());
  });

  it('keeps following carets that are built in one render before any is put into the page: both labels get the name when it arrives', async () => {
    const OTHER = '00000000-0000-4000-8000-000000000002';
    const { builders, arrive } = make();
    const first = builders.cursorBuilder({ id: ID });
    const second = builders.cursorBuilder({ id: OTHER }); // built before the first is in the page
    document.body.append(first, second); // the render puts them in
    await Promise.resolve();
    expect(builders.tracked()).toBe(2);
    arrive(ID, 'Ada');
    arrive(OTHER, 'Bob');
    expect(first.querySelector('.cursor-label')!.textContent).toBe('Ada');
    expect(second.querySelector('.cursor-label')!.textContent).toBe('Bob');
    first.remove();
    second.remove();
  });

  it('stops following the directory when it is disposed of: the editor is gone and the session directory keeps nothing of it', () => {
    const { builders, arrive } = make();
    const caret = builders.cursorBuilder({ id: ID });
    document.body.append(caret);
    builders.dispose();
    expect(builders.tracked()).toBe(0);
    arrive(ID, 'Ada');
    expect(caret.querySelector('.cursor-label')!.textContent).toBe('Someone'); // nothing listens any more
    caret.remove();
  });
});

describe('the place of the name flag', () => {
  const LINE = 30;
  /** Makes `el` report a box at `top` of `height` pixels, as the browser would lay it out. */
  const at = (el: Element, top: number, height = 24): void => {
    el.getBoundingClientRect = () => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) });
  };
  /** A page with `before` (a tag name) and then a paragraph at `top`, with the remote caret put into the paragraph on line `line` (0 is the first). */
  const page = (before: string, top: number, line = 0) => {
    const surface = document.createElement('div');
    surface.className = 'ProseMirror';
    const above = document.createElement(before);
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Some text';
    surface.append(above, paragraph);
    document.body.append(surface);
    at(paragraph, top, LINE * 3);
    const { builders } = make({ [ID]: 'Ada' });
    const caret = builders.cursorBuilder({ id: ID });
    at(caret, top + 3 + line * LINE);
    paragraph.append(caret); // the render puts the caret into the page
    return { caret, label: caret.querySelector<HTMLElement>('.cursor-label')! };
  };
  afterEach(() => document.body.replaceChildren());

  it('goes below the line when a heading sits directly above it', async () => {
    for (const heading of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      const { label } = page(heading, 400);
      await Promise.resolve();
      expect([heading, label.hasAttribute('data-flip')]).toEqual([heading, true]);
      document.body.replaceChildren();
    }
  });

  it('stays above the line when the block above is not a heading, or the caret is on a later line of its block', async () => {
    const { label } = page('p', 400);
    await Promise.resolve();
    expect(label.hasAttribute('data-flip')).toBe(false);
    document.body.replaceChildren();
    const wrapped = page('h2', 400, 2);
    await Promise.resolve();
    expect(wrapped.label.hasAttribute('data-flip')).toBe(false);
  });

  it('stays above the line in a block that is first on the page', async () => {
    const { caret, label } = page('p', 400);
    caret.closest('.ProseMirror')!.firstElementChild!.remove();
    caret.dispatchEvent(new MouseEvent('mouseenter'));
    await Promise.resolve();
    expect(label.hasAttribute('data-flip')).toBe(false);
  });

  it('goes below the line when the line is at the top of the viewport, under the top bar, by the measured height of the flag', async () => {
    const { label } = page('p', TOP_BAR_PX + 2 + 15 - 3 - 1);
    await Promise.resolve();
    expect(label.hasAttribute('data-flip')).toBe(true);
    document.body.replaceChildren();
    const clear = page('p', TOP_BAR_PX + 2 + 15 - 3);
    await Promise.resolve();
    expect(clear.label.hasAttribute('data-flip')).toBe(false);
    // A taller flag (larger text) needs more room.
    Object.defineProperty(clear.label, 'offsetHeight', { configurable: true, value: 30 });
    clear.caret.dispatchEvent(new MouseEvent('mouseenter'));
    expect(clear.label.hasAttribute('data-flip')).toBe(true);
  });

  it('is placed again when the caret is hovered: a scroll since it arrived may have brought the line under the top bar', async () => {
    const { caret, label } = page('p', 400);
    await Promise.resolve();
    expect(label.hasAttribute('data-flip')).toBe(false);
    at(caret, 10);
    caret.dispatchEvent(new MouseEvent('mouseenter'));
    expect(label.hasAttribute('data-flip')).toBe(true);
    at(caret, 400 + 3);
    caret.dispatchEvent(new MouseEvent('mouseenter'));
    expect(label.hasAttribute('data-flip')).toBe(false);
  });

  it('is not placed while the caret is not in the page', async () => {
    const { builders } = make({ [ID]: 'Ada' });
    const caret = builders.cursorBuilder({ id: ID });
    await Promise.resolve();
    caret.dispatchEvent(new MouseEvent('mouseenter'));
    expect(caret.querySelector('.cursor-label')!.hasAttribute('data-flip')).toBe(false);
  });
});
