import { afterEach, describe, expect, it } from 'vitest';
import { createClientStorage } from '../../src/storage';
import { RECENT_MAX, readRecent, recordRecent } from '../../src/palette/recent';
import '../support/dom';

afterEach(() => { localStorage.clear(); });

const page = (n: number) => ({ id: `p${String(n)}`, urlId: `u${String(n)}`, title: `Page ${String(n)}`, path: 'Dev' });

describe('the pages opened last, kept in this browser', () => {
  it('puts the newest first, lists a page once however often it is opened, and keeps at most eight', () => {
    for (let n = 1; n <= RECENT_MAX + 3; n += 1) recordRecent('u', page(n));
    expect(readRecent('u').map((p) => p.id)).toEqual(['p11', 'p10', 'p9', 'p8', 'p7', 'p6', 'p5', 'p4']);
    recordRecent('u', page(6));
    expect(readRecent('u').map((p) => p.id).slice(0, 3)).toEqual(['p6', 'p11', 'p10']);
    expect(readRecent('u')).toHaveLength(RECENT_MAX);
  });

  it('keeps one list for each person', () => {
    recordRecent('a', page(1));
    recordRecent('b', page(2));
    expect(readRecent('a').map((p) => p.id)).toEqual(['p1']);
    expect(readRecent('b').map((p) => p.id)).toEqual(['p2']);
    expect(readRecent('nobody')).toEqual([]);
  });

  it('reads what is not a list of pages as nothing, and storage that is blocked as no list', () => {
    localStorage.setItem('grimoire.recent.u', '{"not":"a list"}');
    expect(readRecent('u')).toEqual([]);
    localStorage.setItem('grimoire.recent.u', 'not json');
    expect(readRecent('u')).toEqual([]);
    localStorage.setItem('grimoire.recent.u', JSON.stringify([page(1), { id: 3 }, 'x']));
    expect(readRecent('u').map((p) => p.id)).toEqual(['p1']);
    const blocked = createClientStorage(null);
    expect(() => { recordRecent('u', page(2), blocked); }).not.toThrow();
    expect(readRecent('u', blocked)).toEqual([]);
  });
});
