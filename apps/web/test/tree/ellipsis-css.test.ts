import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('long names are cut with an ellipsis, not mid-word', () => {
  it('in the contents tree: the library sizes a row to its content, so the row is let shrink to the panel and the link cuts its text', () => {
    const css = read('apps/web/src/tree/tree.css');
    expect(css).toMatch(/\.tree-item\s*\{[^}]*min-width:\s*0\s*!important/);
    expect(css).toMatch(/\.tree-link\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/);
  });

  it('in the breadcrumb: every item shrinks and cuts its name, the separator does not shrink', () => {
    const css = read('apps/web/src/ui/global.css');
    expect(css).toMatch(/\.breadcrumb ol\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.breadcrumb li\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.breadcrumb li > a, \.breadcrumb li > span\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.breadcrumb li \+ li::before\s*\{[^}]*flex:\s*none/);
  });

});
