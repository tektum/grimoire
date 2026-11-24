import { describe, expect, it } from 'vitest';
import { ROUTES, safeReturn, urlIdOf } from '../../src/app/routes';

describe('route table', () => {
  it('has every path of the contract once, with the catch-all last', () => {
    expect(ROUTES.map((r) => r.path)).toEqual(['/login', '/c/:collectionId', '/p/:slug', '/p/:slug/history', '/p/:slug/history/:revisionId', '/search', '/trash', '/import', '/admin/users', '/admin/groups', '/admin/collections/:id/access', '/help', '*']);
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
