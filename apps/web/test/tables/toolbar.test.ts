import { afterEach, describe, expect, it } from 'vitest';
import { tableToolbar } from '../../src/editor/tables';
import '../support/dom';
import { type Harness, makeEditor, TABLE_2X2 } from './support';

let current: Harness | null = null;
afterEach(async () => {
  await current?.destroy();
  current = null;
});
const open = async (markdown = TABLE_2X2, options: { editable?: boolean } = {}): Promise<Harness> => {
  current = await makeEditor(`Before.\n\n${markdown}\nAfter.\n`, tableToolbar, options);
  return current;
};
const toolbar = (h: Harness): HTMLElement | null => h.root.querySelector('[role="toolbar"]');
const press = (h: Harness, name: string): void => {
  const button = Array.from(toolbar(h)?.querySelectorAll('button') ?? []).find((b) => b.getAttribute('aria-label') === name || b.textContent === name);
  if (button === undefined) throw new Error(`no button named ${name}`);
  button.click();
};
const rows = (h: Harness): number => h.view.dom.querySelectorAll('tr').length;
const columns = (h: Harness): number => h.view.dom.querySelector('tr')?.children.length ?? 0;

describe('the table toolbar', () => {
  it('is not there while the cursor is outside a table, and appears with a name and six named buttons when it is inside one', async () => {
    const h = await open();
    h.cursorAtStart();
    expect(toolbar(h)).toBeNull();
    h.cursorInCell(1, 0);
    const bar = toolbar(h);
    expect(bar?.getAttribute('aria-label')).toBe('Table controls');
    expect(Array.from(bar?.querySelectorAll('button') ?? []).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Add row above',
      'Add row below',
      'Add column left',
      'Add column right',
      'Delete row',
      'Delete column',
    ]);
    for (const button of Array.from(bar?.querySelectorAll('button') ?? [])) expect(button.getAttribute('type')).toBe('button');
  });

  it('goes away when the cursor leaves the table', async () => {
    const h = await open();
    h.cursorInCell(0, 0);
    expect(toolbar(h)).not.toBeNull();
    h.cursorAtStart();
    expect(toolbar(h)).toBeNull();
  });

  it('is not shown in an editor that cannot be edited', async () => {
    const h = await open(TABLE_2X2, { editable: false });
    h.cursorInCell(1, 0);
    expect(toolbar(h)).toBeNull();
  });

  it('sits right after the table, so Tab from its last cell reaches it', async () => {
    const h = await open();
    h.cursorInCell(1, 1);
    const table = h.view.dom.querySelector('table') as HTMLElement;
    expect(table.nextElementSibling).toBe(toolbar(h));
  });

  it('Add row below gives 3 rows and the Markdown of a 3-row table', async () => {
    const h = await open();
    h.cursorInCell(1, 0);
    expect(rows(h)).toBe(2);
    press(h, 'Add row below');
    expect(rows(h)).toBe(3);
    expect(h.markdown()).toContain('| a | b |\n| - | - |\n| 1 | 2 |\n|   |   |\n');
  });

  it('Add row above puts the empty row above the cursor row', async () => {
    const h = await open();
    h.cursorInCell(1, 0);
    press(h, 'Add row above');
    expect(rows(h)).toBe(3);
    expect(h.markdown()).toContain('| a | b |\n| - | - |\n|   |   |\n| 1 | 2 |\n');
  });

  it('Add column right and left each give 3 columns', async () => {
    const h = await open();
    h.cursorInCell(0, 0);
    press(h, 'Add column right');
    expect(columns(h)).toBe(3);
    expect(h.markdown()).toContain('| a |   | b |');
    press(h, 'Add column left');
    expect(columns(h)).toBe(4);
    expect(h.markdown()).toContain('|   | a |   | b |');
  });

  it('Delete column gives 2 columns on 2 rows from a 3-column table', async () => {
    const h = await open('| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n');
    h.cursorInCell(1, 1);
    press(h, 'Delete column');
    expect(columns(h)).toBe(2);
    expect(rows(h)).toBe(2);
    expect(h.markdown()).toContain('| a | c |\n| - | - |\n| 1 | 3 |\n');
  });

  it('Delete row removes the cursor row', async () => {
    const h = await open('| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n');
    h.cursorInCell(2, 0);
    press(h, 'Delete row');
    expect(rows(h)).toBe(2);
    expect(h.markdown()).toContain('| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(h.markdown()).not.toContain('3');
  });

  it('keeps the toolbar, and the cursor in the table, after an action', async () => {
    const h = await open();
    h.cursorInCell(1, 0);
    press(h, 'Add row below');
    expect(toolbar(h)).not.toBeNull();
    press(h, 'Add row below');
    expect(rows(h)).toBe(4);
  });

  it('in the header row, Add row above and Delete row are off (a pipe table always has its header first), and pressing them changes nothing', async () => {
    const h = await open('| a | b |\n| - | - |\n| 1 | 2 |\n');
    h.cursorInCell(0, 0);
    const state = (name: string): boolean => (Array.from(toolbar(h)?.querySelectorAll('button') ?? []).find((b) => b.getAttribute('aria-label') === name) as HTMLButtonElement).disabled;
    expect([state('Add row above'), state('Delete row'), state('Add row below'), state('Add column left'), state('Delete column')]).toEqual([true, true, false, false, false]);
    const before = h.markdown();
    press(h, 'Add row above');
    press(h, 'Delete row');
    expect(h.markdown()).toBe(before);
  });

  it('in a body row of a table with several rows every control is on', async () => {
    const h = await open('| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n');
    h.cursorInCell(1, 0);
    for (const button of Array.from(toolbar(h)?.querySelectorAll('button') ?? [])) expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('follows the cursor from the header row to a body row: the controls that were off come on', async () => {
    const h = await open('| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n');
    h.cursorInCell(0, 0);
    expect((toolbar(h)?.querySelector('[aria-label="Delete row"]') as HTMLButtonElement).disabled).toBe(true);
    h.cursorInCell(1, 0);
    expect((toolbar(h)?.querySelector('[aria-label="Delete row"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Delete row is off when the table has only one row under its header (a table keeps at least one), and comes on with a second', async () => {
    const h = await open('| a | b |\n| - | - |\n| 1 | 2 |\n');
    h.cursorInCell(1, 0);
    const deleteRow = (): HTMLButtonElement => toolbar(h)?.querySelector('[aria-label="Delete row"]') as HTMLButtonElement;
    expect(deleteRow().disabled).toBe(true);
    const before = h.markdown();
    press(h, 'Delete row');
    expect(h.markdown()).toBe(before);
    press(h, 'Add row below');
    expect(deleteRow().disabled).toBe(false);
    press(h, 'Delete row');
    expect(rows(h)).toBe(2);
  });

  it('marks the cell the cursor is in, and only that cell, and moves the mark with the cursor', async () => {
    const h = await open();
    const marked = (): string[] => Array.from(h.view.dom.querySelectorAll('.table-cell-active')).map((c) => c.textContent ?? '');
    h.cursorAtStart();
    expect(marked()).toEqual([]);
    h.cursorInCell(1, 1);
    expect(marked()).toEqual(['2']);
    h.cursorInCell(0, 0);
    expect(marked()).toEqual(['a']);
  });

  it('a mouse press on a button does not take the focus from the editor', async () => {
    const h = await open();
    h.cursorInCell(1, 0);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    toolbar(h)?.querySelector('button')?.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });
});
