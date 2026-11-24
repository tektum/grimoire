import { cleanup, render } from '@testing-library/react';
import { diffLines } from 'diff';
import { afterEach, describe, expect, it } from 'vitest';
import { DiffView } from '../../src/screens/history/DiffView';
import '../support/dom';

afterEach(cleanup);

const CURRENT = '# Plan\n\nKeep this line\nOnly in the page now\nAlso only now\nEnd\n';
const REVISION = '# Plan\n\nKeep this line\nOnly in the revision\nEnd\nA new last line\n';
const parts = diffLines(CURRENT, REVISION);
const lines = (kind: 'added' | 'removed') => parts.filter((p) => p[kind] === true).reduce((n, p) => n + (p.count ?? 0), 0);

describe('the line diff', () => {
  it('draws one ins element for each added line and one del element for each removed line, as many as diff.diffLines finds', () => {
    const { container } = render(<DiffView from={CURRENT} to={REVISION} />);
    expect(lines('added')).toBeGreaterThan(0);
    expect(lines('removed')).toBeGreaterThan(0);
    expect(container.querySelectorAll('ins')).toHaveLength(lines('added'));
    expect(container.querySelectorAll('del')).toHaveLength(lines('removed'));
  });

  it('puts the text of each line in its element, and the unchanged lines in neither', () => {
    const { container } = render(<DiffView from={CURRENT} to={REVISION} />);
    expect(Array.from(container.querySelectorAll('del')).map((e) => e.querySelector('[data-text]')?.textContent)).toEqual(['Only in the page now', 'Also only now']);
    expect(Array.from(container.querySelectorAll('ins')).map((e) => e.querySelector('[data-text]')?.textContent)).toEqual(['Only in the revision', 'A new last line']);
    expect(container.textContent).toContain('Keep this line');
    expect(container.querySelector('ins, del')?.closest('[data-line="same"]')).toBeNull();
  });

  it('says in words, not only by marks, which lines are added and which are removed', () => {
    const { container } = render(<DiffView from={'a\n'} to={'b\n'} />);
    expect(container.querySelector('ins')?.textContent).toContain('Added');
    expect(container.querySelector('del')?.textContent).toContain('Removed');
  });

  it('says there is no difference when the texts are the same', () => {
    const { container, getByText } = render(<DiffView from={CURRENT} to={CURRENT} />);
    expect(getByText('The page is the same as this version.')).toBeTruthy();
    expect(container.querySelectorAll('ins, del')).toHaveLength(0);
  });

  it('shows markup in a line as text, never as elements', () => {
    const hostile = '<img src=x onerror=alert(1)>\n<script>window.hacked=1</script>\n[x](javascript:alert(1))\n';
    const { container } = render(<DiffView from="" to={hostile} />);
    expect(container.querySelector('img, script, a')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
