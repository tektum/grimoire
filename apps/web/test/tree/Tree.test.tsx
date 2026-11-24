import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { buildTree } from '../../src/tree/model';
import { Tree } from '../../src/tree/Tree';
import type { TreeItem } from '../../src/tree/model';
import '../support/dom';

const leaf = (id: string, name: string): TreeItem => ({ id, urlId: id, title: name, name, icon: null });
const items: TreeItem[] = [
  { id: 'welcome', urlId: 'welcome', title: 'Welcome', name: 'Welcome', icon: '📘', children: [leaf('nested', 'Nested'), { id: 'deep', urlId: 'deep', title: 'Deep', name: 'Deep', icon: null, children: [leaf('deeper', 'Deeper')] }] },
  leaf('plain', 'Plain page'),
];
const show = () => render(<MemoryRouter><Tree items={items} /></MemoryRouter>);
const Where = () => <output aria-label="location">{useLocation().pathname}</output>;
const names = () => screen.getAllByRole('treeitem').map((row) => within(row).getByRole('link').textContent);

describe('Tree', () => {
  it('shows the top level with its first-level pages open and deeper ones closed', () => {
    show();
    expect(names()).toEqual(['📘Welcome', 'Nested', 'Deep', 'Plain page']);
    const rows = screen.getAllByRole('treeitem');
    expect(rows.map((r) => r.getAttribute('aria-level'))).toEqual(['1', '2', '2', '1']);
    expect([rows[0], rows[2]].map((r) => r?.getAttribute('aria-expanded'))).toEqual(['true', 'false']); // the open and the closed branch
  });

  it('links every row to /p/<slug>-<urlId>', () => {
    show();
    expect(screen.getByRole('link', { name: 'Plain page' }).getAttribute('href')).toBe('/p/plain-page-plain');
    expect(screen.getByRole('link', { name: /Welcome/ }).getAttribute('href')).toBe('/p/welcome-welcome');
  });

  it('opens and closes a branch with its toggle button, named after the page', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Expand Deep' }));
    expect(names()).toContain('Deeper');
    await userEvent.click(screen.getByRole('button', { name: 'Collapse Welcome' }));
    expect(names()).toEqual(['📘Welcome', 'Plain page']);
  });

  it('opens and closes a branch from the keyboard with the arrow keys', async () => {
    show();
    const deep = screen.getAllByRole('treeitem')[2] as HTMLElement;
    await userEvent.click(deep);
    expect(names()).not.toContain('Deeper'); // selecting the row does not open it
    await userEvent.keyboard('{ArrowRight}');
    expect(names()).toContain('Deeper');
    await userEvent.keyboard('{ArrowLeft}');
    expect(names()).not.toContain('Deeper');
  });

  it('says so when the collection has no page', () => {
    render(<MemoryRouter><Tree items={[]} /></MemoryRouter>);
    expect(screen.getByText('No pages yet')).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('marks the page being read as the current page', () => {
    render(<MemoryRouter><Tree items={items} currentUrlId="nested" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Nested' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Plain page' }).getAttribute('aria-current')).toBeNull();
  });

  it('opens the page of the focused row with Enter, reaching the row with Tab and the arrow keys only', async () => {
    render(<MemoryRouter><Tree items={items} /><Where /></MemoryRouter>);
    await userEvent.tab(); // into the tree: the first row
    await userEvent.keyboard('{ArrowDown}'); // Nested
    expect(screen.getByLabelText('location').textContent).toBe('/'); // nothing has opened a page yet
    await userEvent.keyboard('{Enter}');
    expect(screen.getByLabelText('location').textContent).toBe('/p/nested-nested');
  });

  it('gives a page with no title the slug "page", not the shown "Untitled"', () => {
    render(<MemoryRouter><Tree items={buildTree([{ id: 'n1', urlId: 'a1b2c3d4', parentId: null, position: 'p1', title: '', icon: null }])} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Untitled' }).getAttribute('href')).toBe('/p/page-a1b2c3d4');
  });

  it('keeps its rows (and the focus inside them) when the list is read again with the same pages', async () => {
    const view = render(<MemoryRouter><Tree items={items} /></MemoryRouter>);
    const toggle = screen.getByRole('button', { name: 'Collapse Welcome' });
    toggle.focus();
    view.rerender(<MemoryRouter><Tree items={structuredClone(items)} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Collapse Welcome' })).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
  });

  it('opens a branch with its toggle without opening its page', async () => {
    render(<MemoryRouter><Tree items={items} /><Where /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: 'Expand Deep' }));
    expect(screen.getByLabelText('location').textContent).toBe('/');
    expect(screen.getAllByRole('treeitem')).toHaveLength(5);
  });

  it('marks the row that has the focus, and moves the mark with the arrow keys', async () => {
    show();
    const marked = () => Array.from(document.querySelectorAll('.tree-row[data-focused]')).map((r) => r.textContent);
    await userEvent.click(screen.getAllByRole('treeitem')[0]?.querySelector('.tree-row') as HTMLElement);
    expect(marked()).toEqual(['📘Welcome']);
    await userEvent.keyboard('{ArrowDown}');
    expect(marked()).toEqual(['Nested']);
  });

  it('lets the link do the opening when it is clicked: the row is not also selected and activated', async () => {
    render(<MemoryRouter><Tree items={items} /><Where /></MemoryRouter>);
    await userEvent.click(screen.getByRole('link', { name: 'Plain page' }));
    expect(screen.getByLabelText('location').textContent).toBe('/p/plain-page-plain');
    expect(screen.getAllByRole('treeitem').map((r) => r.getAttribute('aria-selected'))).not.toContain('true');
  });
});
