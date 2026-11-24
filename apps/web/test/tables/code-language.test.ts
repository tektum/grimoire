import { afterEach, describe, expect, it } from 'vitest';
import { codeLanguage } from '../../src/editor/code';
import '../support/dom';
import { type Harness, makeEditor } from './support';

let current: Harness | null = null;
afterEach(async () => {
  await current?.destroy();
  current = null;
});
const open = async (markdown: string, options: { editable?: boolean } = {}): Promise<Harness> => {
  current = await makeEditor(markdown, codeLanguage, options);
  await Promise.resolve(); // the picker draws once more, a moment after the editor is up
  return current;
};
const pickers = (h: Harness): HTMLSelectElement[] => Array.from(h.root.querySelectorAll<HTMLSelectElement>('select.code-language'));
const choose = (select: HTMLSelectElement, value: string): void => {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
};
const TWO = 'Intro.\n\n```\nplain text\n```\n\nMiddle.\n\n```js\nconsole.log(1);\n```\n';

describe('the code-block language picker', () => {
  it('shows a named select for the code block the cursor is in, with the language the block has (plain text for none), and for no other', async () => {
    const h = await open(TWO);
    h.cursorAtStart();
    expect(pickers(h)).toHaveLength(0);
    h.cursorInCode(0);
    expect(pickers(h)).toHaveLength(1);
    expect(pickers(h)[0]?.getAttribute('aria-label')).toBe('Language of this code block');
    expect(pickers(h)[0]?.value).toBe('');
    h.cursorInCode(1);
    expect(pickers(h)).toHaveLength(1);
    expect(pickers(h)[0]?.value).toBe('js');
    h.cursorAtStart();
    expect(pickers(h)).toHaveLength(0);
  });

  it('sits right after its block, outside the block, with a visible label', async () => {
    const h = await open(TWO);
    h.cursorInCode(0);
    const bar = pickers(h)[0]?.parentElement as HTMLElement;
    expect(bar.previousElementSibling?.tagName).toBe('PRE');
    expect(bar.textContent).toContain('Language');
  });

  it('offers a fixed list, plain text first, and nothing else', async () => {
    const h = await open('```\nx\n```\n');
    h.cursorInCode(0);
    const options = Array.from(pickers(h)[0]?.options ?? []).map((o) => [o.value, o.textContent]);
    expect(options[0]).toEqual(['', 'Plain text']);
    expect(options.map((o) => o[0])).toEqual(['', 'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'go', 'html', 'java', 'js', 'json', 'kotlin', 'markdown', 'php', 'python', 'ruby', 'rust', 'sql', 'swift', 'ts', 'xml', 'yaml']);
  });

  it('sets the language to ts, and the Markdown fence reads ```ts', async () => {
    const h = await open('```\nconst a: number = 1;\n```\n');
    h.cursorInCode(0);
    choose(pickers(h)[0] as HTMLSelectElement, 'ts');
    const block = h.view.state.doc.firstChild;
    expect(block?.type.name).toBe('code_block');
    expect(block?.attrs['language']).toBe('ts');
    expect(h.markdown()).toContain('```ts\nconst a: number = 1;\n```');
  });

  it('changes only the block the cursor is in', async () => {
    const h = await open(TWO);
    h.cursorInCode(0);
    choose(pickers(h)[0] as HTMLSelectElement, 'python');
    expect(h.markdown()).toContain('```python\nplain text\n```');
    expect(h.markdown()).toContain('```js\nconsole.log(1);\n```');
  });

  it('Plain text takes the language away: a bare fence', async () => {
    const h = await open('```js\nx\n```\n');
    h.cursorInCode(0);
    choose(pickers(h)[0] as HTMLSelectElement, '');
    expect(h.markdown()).toContain('```\nx\n```');
    expect(h.markdown()).not.toContain('```js');
  });

  it('keeps a language that is not in the list as it is, shown as its own entry, instead of changing it', async () => {
    const h = await open('```brainfuck\n+\n```\n');
    h.cursorInCode(0);
    const select = pickers(h)[0] as HTMLSelectElement;
    expect(select.value).toBe('brainfuck');
    expect(Array.from(select.options).filter((o) => o.value === 'brainfuck')).toHaveLength(1);
    expect(h.markdown()).toContain('```brainfuck');
  });

  it('keeps the same select, and the focus on it, across changes: typing in it is not interrupted', async () => {
    const h = await open(TWO);
    h.cursorInCode(1);
    const select = pickers(h)[0] as HTMLSelectElement;
    select.focus();
    choose(select, 'go');
    choose(select, 'json');
    expect(pickers(h)[0]).toBe(select);
    expect(document.activeElement).toBe(select);
    expect(select.value).toBe('json');
  });

  it('is not shown in an editor that cannot be edited', async () => {
    const h = await open(TWO, { editable: false });
    h.cursorInCode(0);
    expect(pickers(h)).toHaveLength(0);
  });

  it("shows the language a peer set, and gives one that is not in the list its own entry", async () => {
    const h = await open('```\nx\n```\n');
    h.cursorInCode(0);
    h.view.dispatch(h.view.state.tr.setNodeMarkup(0, undefined, { ...h.view.state.doc.firstChild?.attrs, language: 'sql' }));
    expect(pickers(h)[0]?.value).toBe('sql');
    h.view.dispatch(h.view.state.tr.setNodeMarkup(0, undefined, { ...h.view.state.doc.firstChild?.attrs, language: 'zig' }));
    const select = pickers(h)[0] as HTMLSelectElement;
    expect(select.value).toBe('zig');
    expect(Array.from(select.options).filter((o) => o.value === 'zig')).toHaveLength(1);
  });

  it('drops the entry of a language that is no longer shown: zig then sql leaves no zig, and moving between two blocks leaves only the current one', async () => {
    const h = await open('```\nx\n```\n\nMiddle.\n\n```brainfuck\ny\n```\n');
    h.cursorInCode(0);
    h.view.dispatch(h.view.state.tr.setNodeMarkup(0, undefined, { ...h.view.state.doc.firstChild?.attrs, language: 'zig' }));
    expect(Array.from((pickers(h)[0] as HTMLSelectElement).options).map((o) => o.value)).toContain('zig');
    h.view.dispatch(h.view.state.tr.setNodeMarkup(0, undefined, { ...h.view.state.doc.firstChild?.attrs, language: 'sql' }));
    const values = (): string[] => Array.from((pickers(h)[0] as HTMLSelectElement).options).map((o) => o.value);
    expect(values()).not.toContain('zig');
    expect(pickers(h)[0]?.value).toBe('sql');
    h.cursorInCode(1);
    expect(pickers(h)[0]?.value).toBe('brainfuck');
    expect(values().filter((v) => v === 'brainfuck')).toHaveLength(1);
    h.cursorInCode(0);
    expect(values()).not.toContain('brainfuck');
    expect(pickers(h)[0]?.value).toBe('sql');
  });

  it('does nothing when the change comes after the cursor has left every code block', async () => {
    const h = await open('Intro.\n\n```\nx\n```\n');
    h.cursorInCode(0);
    const select = pickers(h)[0] as HTMLSelectElement;
    h.cursorAtStart();
    choose(select, 'ts');
    expect(h.markdown()).toContain('```\nx\n```');
  });

  it('leaves the text of the document alone: the picker is not part of the code', async () => {
    const h = await open('```js\nx\n```\n');
    h.cursorInCode(0);
    expect(h.view.state.doc.textContent).toBe('x');
    expect(h.markdown()).toContain('```js\nx\n```');
  });
});
