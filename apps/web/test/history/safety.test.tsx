import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RevisionBody } from '../../src/screens/history/RevisionBody';
import { isSafeHref } from '../../src/safety';
import { xssCorpus } from '../corpus/xss';
import '../support/dom';
import { renderAt } from './support';

const links = xssCorpus.filter((e) => e.href !== undefined && (e.expect === 'link-kept' || e.expect === 'link-refused'));

/** A read-only editor that draws these links as the editor schema would (every address, as the stored Markdown has it) and then, later, one more. */
const drawing = (hrefs: readonly string[], later?: string) => async (element: HTMLElement) => {
  const root = document.createElement('div');
  root.className = 'ProseMirror';
  for (const [i, href] of hrefs.entries()) {
    const a = document.createElement('a');
    a.setAttribute('href', href);
    a.textContent = `link ${String(i)}`;
    root.append(a);
  }
  element.append(root);
  if (later !== undefined) {
    setTimeout(() => {
      const a = document.createElement('a');
      a.setAttribute('href', later);
      a.textContent = 'late link';
      root.append(a);
    }, 0);
  }
  return { setEditable: () => undefined, markdown: () => '', applyMarkdown: () => undefined, destroy: async () => undefined };
};

describe('links in a version follow the one rule (contracts section 8, rule 1)', () => {
  it('keeps the links isSafeHref accepts and leaves the text of the ones it refuses, for every address of the corpus', async () => {
    expect(links.length).toBeGreaterThan(10);
    const hrefs = links.map((e) => e.href as string);
    renderAt(<RevisionBody markdown="x" mount={drawing(hrefs)} />);
    await waitFor(() => { expect(screen.getByTestId('revision-text').querySelector('.ProseMirror')).toBeTruthy(); });
    await waitFor(() => {
      const kept = Array.from(screen.getByTestId('revision-text').querySelectorAll('a')).map((a) => a.getAttribute('href'));
      expect(kept).toEqual(hrefs.filter((h) => isSafeHref(h)));
    });
    const text = screen.getByTestId('revision-text').textContent ?? '';
    for (const [i] of hrefs.entries()) expect(text).toContain(`link ${String(i)}`); // the text of a refused link stays
  });

  it('also refuses a link that is drawn after the editor was built', async () => {
    renderAt(<RevisionBody markdown="x" mount={drawing(['https://a.test/x'], 'javascript:alert(1)')} />);
    await waitFor(() => { expect(screen.getByTestId('revision-text').textContent).toContain('late link'); });
    expect(Array.from(screen.getByTestId('revision-text').querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['https://a.test/x']);
  });

  it('refuses a link whose address is changed after it was drawn', async () => {
    renderAt(<RevisionBody markdown="x" mount={drawing(['https://a.test/x'])} />);
    const a = await waitFor(() => {
      const found = screen.getByTestId('revision-text').querySelector('a');
      if (found === null) throw new Error('not yet');
      return found;
    });
    a.setAttribute('href', 'javascript:alert(1)');
    await waitFor(() => { expect(screen.getByTestId('revision-text').querySelectorAll('a')).toHaveLength(0); });
    expect(screen.getByTestId('revision-text').textContent).toContain('link 0');
  });
});
