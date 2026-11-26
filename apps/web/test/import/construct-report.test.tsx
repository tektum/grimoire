import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConstructKind, ConstructLine, ImportConstructReport } from '../../src/import/types';
import { ConstructReport } from '../../src/screens/import/ConstructReport';
import '../support/dom';

afterEach(cleanup);

const FATES: Record<ConstructKind, ConstructLine['fate']> = {
  callout: 'converted',
  toggle: 'converted',
  page_mention: 'converted',
  database_table: 'converted',
  front_matter: 'dropped',
  icon_cover: 'dropped',
  database_row: 'dropped',
  unresolved_link: 'kept',
  raw_html: 'kept',
};
const line = (kind: ConstructKind, over: Partial<ConstructLine> = {}): ConstructLine => ({
  kind,
  fate: FATES[kind],
  count: 3,
  pages: [{ itemId: '1', path: 'handbook/welcome.md', urlId: 'abc123' }],
  capped: false,
  ...over,
});
const report = (over: Partial<ImportConstructReport> = {}): ImportConstructReport => ({ constructs: [], rawHtmlPages: [], rawHtmlCapped: false, ...over });
const show = (r: ImportConstructReport | undefined) =>
  render(
    <MemoryRouter>
      <ConstructReport report={r} />
    </MemoryRouter>,
  );

describe('the construct report of an ended import', () => {
  it('is not there for a server that says nothing, or when nothing was converted, dropped or kept', () => {
    show(undefined);
    expect(screen.queryByRole('heading', { name: 'What happened to the content' })).toBeNull();
    cleanup();
    show(report());
    expect(screen.queryByRole('heading', { name: 'What happened to the content' })).toBeNull();
  });

  it('names every kind in plain words with what became of it, and how many there were', () => {
    show(report({ constructs: Object.keys(FATES).map((k) => line(k as ConstructKind, { count: k === 'callout' ? 1204 : 3 })) }));
    const table = screen.getByRole('table', { name: /what the import did to each kind of content/i });
    const rows = within(table).getAllByRole('row').slice(1);
    const text = (kind: string) => rows.find((r) => within(r).queryByRole('rowheader', { name: kind }) !== null)?.textContent ?? '';
    expect(rows).toHaveLength(9);
    expect(text('Callouts')).toContain('Converted');
    expect(text('Callouts')).toContain('1204');
    expect(text('Toggles')).toContain('Converted');
    expect(text('Mentions of other pages')).toContain('now links to the imported page');
    expect(text('Database tables')).toContain('is now a table');
    expect(text('Database tables')).toContain('rows with text of their own are pages under it');
    expect(text('Front matter (properties at the top of a file)')).toContain('Left out');
    expect(text('Icons and cover images')).toContain('Left out');
    expect(text('Rows that only repeat their table')).toContain('Left out: the table already shows what these pages said');
    expect(text('Rows that only repeat their table')).toContain('A link to one opens the page of the table');
    expect(text('Links and images whose file is not in the zip')).toContain('Kept as written');
    expect(text('HTML left in pages')).toContain('Kept as written');
  });

  it('says what happened in words, not by colour: the fate of a row is its own text and a data attribute for the style', () => {
    show(report({ constructs: [line('callout'), line('front_matter'), line('unresolved_link')] }));
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((r) => r.getAttribute('data-fate'))).toEqual(['converted', 'dropped', 'kept']);
    expect(rows.map((r) => /Converted|Left out|Kept as written/.exec(r.textContent ?? '')?.[0])).toEqual(['Converted', 'Left out', 'Kept as written']);
  });

  it('lists the pages that hold a kind behind a disclosure, each a link to the page when it has an address and plain text when it was left out', async () => {
    show(
      report({
        constructs: [
          line('database_row', {
            count: 2,
            pages: [
              { itemId: '1', path: 'db/Row one.md', urlId: null },
              { itemId: '2', path: 'handbook/welcome.md', urlId: 'abc123' },
            ],
          }),
        ],
      }),
    );
    const summary = screen.getByText('2 pages');
    expect(summary.tagName).toBe('SUMMARY');
    await userEvent.click(summary);
    expect(screen.getByRole('link', { name: 'handbook/welcome.md' }).getAttribute('href')).toBe('/p/welcome-abc123');
    expect(screen.getByText('db/Row one.md').closest('a')).toBeNull();
  });

  it('says so when more pages hold a kind than are listed, and does not claim a number it cannot know', () => {
    show(report({ constructs: [line('callout', { count: 900, capped: true, pages: Array.from({ length: 100 }, (_, i) => ({ itemId: String(i), path: `p/${String(i)}.md`, urlId: `u${String(i)}` })) })] }));
    expect(screen.getByText('First 100 pages')).toBeTruthy();
    expect(screen.getByText('More pages hold it than are listed here.')).toBeTruthy();
  });

  it('shows a path as text, whatever it holds: nothing in it becomes markup or an address', () => {
    show(report({ constructs: [line('callout', { pages: [{ itemId: '1', path: '<img src=x onerror=alert(1)>.md', urlId: 'abc123' }] })] }));
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: '<img src=x onerror=alert(1)>.md' }).getAttribute('href')).toBe('/p/img-src-x-onerror-alert-1-abc123');
  });

  it('lists the pages that still hold HTML with the number of fragments, and what to do about it, and says when the list is cut', () => {
    show(
      report({
        constructs: [line('raw_html', { count: 4 })],
        rawHtmlPages: [
          { itemId: '1', path: 'handbook/embeds.md', urlId: 'abc123', fragments: 3 },
          { itemId: '2', path: 'handbook/one.md', urlId: 'def456', fragments: 1 },
        ],
        rawHtmlCapped: true,
      }),
    );
    const heading = screen.getByRole('heading', { name: 'Pages that still hold HTML' });
    const list = within(heading.parentElement as HTMLElement).getByRole('list');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['handbook/embeds.md (3 fragments)', 'handbook/one.md (1 fragment)']);
    expect(screen.getByText(/Open each page and clean up the HTML by hand/)).toBeTruthy();
    expect(screen.getByText('Only the first 2 pages are listed; more pages hold HTML.')).toBeTruthy();
  });

  it('has no list of HTML pages when none holds any', () => {
    show(report({ constructs: [line('callout')] }));
    expect(screen.queryByRole('heading', { name: 'Pages that still hold HTML' })).toBeNull();
  });
});
