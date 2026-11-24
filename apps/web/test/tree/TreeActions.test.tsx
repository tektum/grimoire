import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { messageFor } from '../../src/api/messages';
import type { TreeActions } from '../../src/tree/actions';
import { dropPage } from '../../src/tree/drop';
import { Tree } from '../../src/tree/Tree';
import { buildTree, type FlatPage } from '../../src/tree/model';
import '../support/dom';

const flat = (id: string, parentId: string | null, position: string, title: string): FlatPage => ({ id, urlId: id, parentId, position, title, icon: null });
const PAGES = [flat('a', null, 'p1', 'Alpha'), flat('b', null, 'p2', 'Beta'), flat('a1', 'a', 'p1', 'Alpha one')];
const ok = () => Promise.resolve({ ok: true as const, data: undefined });
const fakeActions = () => ({ create: vi.fn<TreeActions['create']>(ok), rename: vi.fn<TreeActions['rename']>(ok), move: vi.fn<TreeActions['move']>(ok), remove: vi.fn<TreeActions['remove']>(ok) }) satisfies TreeActions;
const show = (actions: TreeActions | null = fakeActions()) => render(<MemoryRouter><Tree items={buildTree(PAGES)} editing={actions === null ? undefined : { actions, pages: PAGES }} /></MemoryRouter>);
const openMenu = async (title: string) => { await userEvent.click(screen.getByRole('button', { name: `Actions for ${title}` })); };

describe('the row menu', () => {
  it('opens and works without opening the page of its row', async () => {
    const Where = () => <output aria-label="location">{useLocation().pathname}</output>;
    render(<MemoryRouter><Tree items={buildTree(PAGES)} editing={{ actions: fakeActions(), pages: PAGES }} /><Where /></MemoryRouter>);
    await openMenu('Beta');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Top level' }));
    expect(screen.getByLabelText('location').textContent).toBe('/');
  });

  it('has a menu on every row, with the four actions', async () => {
    show();
    await openMenu('Beta');
    expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual(['Rename', 'New page inside', 'Move to…', 'Delete']);
  });

  it('has no menu, no rename and no drag in a collection the caller can only read', () => {
    show(null);
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  });

  it('makes a page inside the one the menu belongs to', async () => {
    const actions = fakeActions();
    show(actions);
    await openMenu('Beta');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'New page inside' }));
    expect(actions.create).toHaveBeenCalledWith('b');
  });
});

describe('showing where a page went', () => {
  const NESTED = [flat('r', null, 'p1', 'Root'), flat('m', 'r', 'p1', 'Middle'), flat('l', 'm', 'p1', 'Leaf')];
  const treeitem = (name: string) => screen.getAllByRole('treeitem').find((r) => within(r).queryByRole('link', { name }) !== null) as HTMLElement;

  it('opens a closed branch when a page is made inside it', async () => {
    render(<MemoryRouter><Tree items={buildTree(NESTED)} editing={{ actions: fakeActions(), pages: NESTED }} /></MemoryRouter>);
    expect(treeitem('Middle').getAttribute('aria-expanded')).toBe('false');
    await openMenu('Middle');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'New page inside' }));
    await waitFor(() => { expect(treeitem('Middle').getAttribute('aria-expanded')).toBe('true'); });
  });

  it('opens the branch a page was moved into', async () => {
    const pages = [...NESTED, flat('o', null, 'p2', 'Other'), flat('p', 'o', 'p1', 'Pending'), flat('q', 'p', 'p1', 'Quiet')];
    render(<MemoryRouter><Tree items={buildTree(pages)} editing={{ actions: fakeActions(), pages }} /></MemoryRouter>);
    expect(treeitem('Pending').getAttribute('aria-expanded')).toBe('false');
    await openMenu('Root');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Pending' }));
    await waitFor(() => { expect(treeitem('Pending').getAttribute('aria-expanded')).toBe('true'); });
  });
});

describe('rename', () => {
  it('opens a text field with the title, saves the typed title on Enter and sends it once', async () => {
    const actions = fakeActions();
    show(actions);
    await openMenu('Beta');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const field = await screen.findByRole('textbox', { name: 'New title for Beta' });
    expect((field as HTMLInputElement).value).toBe('Beta');
    expect([(field as HTMLInputElement).selectionStart, (field as HTMLInputElement).selectionEnd]).toEqual([0, 4]); // the title is selected: typing replaces it
    await userEvent.clear(field);
    await userEvent.type(field, 'Plan for May{Enter}');
    await waitFor(() => { expect(actions.rename).toHaveBeenCalledTimes(1); });
    expect(actions.rename).toHaveBeenCalledWith('b', 'Plan for May');
  });

  it('keeps the title when the field is left empty or Escape is pressed', async () => {
    const actions = fakeActions();
    show(actions);
    for (const ending of ['{Enter}', '{Escape}']) {
      await openMenu('Beta');
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
      const field = await screen.findByRole('textbox', { name: 'New title for Beta' });
      await userEvent.clear(field);
      await userEvent.type(field, ending);
      await waitFor(() => { expect(screen.queryByRole('textbox')).toBeNull(); });
    }
    expect(actions.rename).not.toHaveBeenCalled();
  });
});

describe('Move to…', () => {
  it('lists the places a page can go, never itself or what is below it, and moves it last under the chosen one, from the keyboard alone', async () => {
    const actions = fakeActions();
    show(actions);
    await openMenu('Alpha');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move Alpha to…' });
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Top level', 'Beta', 'Close']);
    // Tab to "Beta" and press Enter: no pointer event.
    within(dialog).getByRole('button', { name: 'Top level' }).focus();
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    expect(actions.move).toHaveBeenCalledWith('a', { parentId: 'b', afterId: null, beforeId: null });
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  });

  it('can move a sub-page to the top level', async () => {
    const actions = fakeActions();
    show(actions);
    await openMenu('Alpha one');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Top level' }));
    expect(actions.move).toHaveBeenCalledWith('a1', { parentId: null, afterId: null, beforeId: null });
  });
});

describe('delete', () => {
  it('asks first, says the pages inside go to the trash, and deletes only when confirmed', async () => {
    const actions = fakeActions();
    show(actions);
    await openMenu('Alpha');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Alpha?' });
    expect(within(dialog).getByText(/go to the trash/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(actions.remove).not.toHaveBeenCalled();
    await openMenu('Alpha');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(actions.remove).toHaveBeenCalledWith('a');
  });
});

describe('a dropped page', () => {
  const say = vi.fn();
  it('is moved after the sibling above the drop place, before the first one, or last', () => {
    const actions = fakeActions();
    dropPage(PAGES, actions, say, { dragId: 'a1', parentId: null, index: 1 });
    dropPage(PAGES, actions, say, { dragId: 'b', parentId: null, index: 0 });
    dropPage(PAGES, actions, say, { dragId: 'b', parentId: 'a', index: 1 });
    expect(actions.move.mock.calls).toEqual([
      ['a1', { parentId: null, afterId: 'a', beforeId: null }],
      ['b', { parentId: null, afterId: null, beforeId: 'a' }],
      ['b', { parentId: 'a', afterId: null, beforeId: null }],
    ]);
    expect(say).not.toHaveBeenCalled();
  });
  it('sends nothing and says why for a drop into itself or below itself', () => {
    const actions = fakeActions();
    dropPage(PAGES, actions, say, { dragId: 'a', parentId: 'a1', index: 0 });
    expect(actions.move).not.toHaveBeenCalled();
    expect(say.mock.calls.map((c) => c[0])).toEqual([messageFor('would_create_cycle')]);
    expect(messageFor('would_create_cycle')).toBe("A page can't be moved into itself or its own sub-pages");
  });
});

describe('closing the dialogs', () => {
  it('Escape closes Move to… and Delete without sending anything', async () => {
    const actions = fakeActions();
    show(actions);
    await openMenu('Alpha');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    await openMenu('Alpha');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await screen.findByRole('alertdialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('alertdialog')).toBeNull(); });
    expect(actions.move).not.toHaveBeenCalled();
    expect(actions.remove).not.toHaveBeenCalled();
  });
});

describe('dragging a row', () => {
  it('asks for the move of the page that was dropped (the place comes from the pointer position, which is tested on dropPage)', async () => {
    const actions = fakeActions();
    show(actions);
    const rows = screen.getAllByRole('treeitem');
    const dragged = rows.find((r) => within(r).queryByRole('link', { name: 'Beta' }) !== null) as HTMLElement;
    const target = rows.find((r) => within(r).queryByRole('link', { name: 'Alpha' }) !== null) as HTMLElement;
    const data = { setData: () => undefined, getData: () => '', dropEffect: 'move', effectAllowed: 'all', types: [], files: [], items: [], setDragImage: () => undefined };
    const row = (el: HTMLElement) => el.querySelector('.tree-row') as HTMLElement;
    fireEvent.dragStart(row(dragged), { dataTransfer: data });
    fireEvent.dragEnter(row(target), { dataTransfer: data });
    fireEvent.dragOver(row(target), { dataTransfer: data });
    fireEvent.drop(row(target), { dataTransfer: data });
    fireEvent.dragEnd(row(dragged), { dataTransfer: data });
    await waitFor(() => { expect(actions.move).toHaveBeenCalledTimes(1); });
    expect(actions.move.mock.calls[0]?.[0]).toBe('b');
  });
});
