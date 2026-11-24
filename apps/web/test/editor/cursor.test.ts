import { describe, expect, it } from 'vitest';
import { LABEL_MS, cursorBuilders } from '../../src/editor/core/cursor';
import { UNKNOWN_NAME, type Directory } from '../../src/editor/core/directory';
import { COLLAB_COLOURS, colourIndex, labelText } from '../../src/ui/collab';
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
    expect(caret.style.getPropertyValue('--cursor')).toBe(colour);
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

  it('shows the label on arrival and for 3 seconds, then hides it', async () => {
    const { clock, builders } = make({ [ID]: 'Ada' });
    const label = builders.cursorBuilder({ id: ID }).querySelector('.cursor-label')!;
    expect(label.classList.contains('cursor-label--shown')).toBe(true);
    await clock.advance(LABEL_MS - 1);
    expect(label.classList.contains('cursor-label--shown')).toBe(true);
    await clock.advance(1);
    expect(label.classList.contains('cursor-label--shown')).toBe(false);
    expect(LABEL_MS).toBe(3000);
  });

  it('is still a cursor, with some colour and "Someone", when the peer published no id', () => {
    const { builders, requested } = make();
    for (const user of [undefined, null, {}, { id: 5 }, 'x']) {
      const caret = builders.cursorBuilder(user);
      expect(caret.querySelector('.cursor-label')!.textContent).toBe('Someone');
      expect(COLLAB_COLOURS).toContain(caret.style.getPropertyValue('--cursor') as never);
    }
    expect(requested).toEqual([]);
  });

  it("draws a selection with a tint of the person's colour", () => {
    const { builders } = make();
    const colour = COLLAB_COLOURS[colourIndex(ID)]!;
    expect(builders.selectionBuilder({ id: ID })).toEqual({ class: 'ProseMirror-yjs-selection', style: `background-color: ${colour}33` });
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
});
