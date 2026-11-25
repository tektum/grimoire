import { describe, expect, it } from 'vitest';
import { ROUTES, safeReturn, screenKey, urlIdOf } from '../../src/app/routes';

describe('route table', () => {
  it('has every path of the contract once, with the catch-all last', () => {
    expect(ROUTES.map((r) => r.path)).toEqual(['/login', '/collections/new', '/c/:collectionId', '/p/:slug', '/p/:slug/history', '/p/:slug/history/:revisionId', '/search', '/trash', '/import', '/admin/users', '/admin/groups', '/admin/collections/:id/access', '/help', '*']);
    expect(ROUTES.at(-1)?.screen).toBe('notfound');
  });
  it('takes the page id from after the last dash of the slug', () => {
    expect(urlIdOf('my-first-page-ab12cd')).toBe('ab12cd');
    expect(urlIdOf('ab12cd')).toBe('ab12cd');
  });
});

describe('safeReturn', () => {
  it.each(['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '', '/%0d/x\r\n', '/javascript:alert(1)', 'evil', '\\\\evil', '///evil'])('refuses %j', (bad) => {
    expect(safeReturn(bad)).toBe('/');
  });
  it('refuses a missing value and keeps a local path with its query', () => {
    expect(safeReturn(null)).toBe('/');
    expect(safeReturn('/p/a-b1?x=1#h')).toBe('/p/a-b1?x=1#h');
  });
});

describe('the key of the main area', () => {
  it('is the same for a page under any slug (a rename changes the address, not the screen)', () => {
    expect(screenKey('/p/plan-ab12cd')).toBe(screenKey('/p/a-much-longer-title-ab12cd'));
    expect(screenKey('/p/page-ab12cd')).toBe('/p/ab12cd');
  });
  it('tells a page from its history and from the revision of it, and a page from another page', () => {
    const keys = new Set([screenKey('/p/plan-ab12cd'), screenKey('/p/plan-ab12cd/history'), screenKey('/p/plan-ab12cd/history/r1'), screenKey('/p/plan-zz99')]);
    expect(keys.size).toBe(4);
    expect(screenKey('/p/new-name-ab12cd/history/r1')).toBe(screenKey('/p/plan-ab12cd/history/r1'));
  });
  it('is the address itself for every other screen', () => {
    for (const path of ['/', '/c/c1', '/trash', '/search', '/admin/users', '/p']) expect(screenKey(path)).toBe(path);
  });
});
