import { describe, expect, it } from 'vitest';
import { decodeSearchCursor, encodeSearchCursor } from '../../../src/search/cursor.js';
import { bestChunkPerPage, compareFused, fuse, pageOf, RRF_K, type Candidate, type ChunkMatch, type FusedRow } from '../../../src/search/hybrid.js';

const c = (id: string, editedAt = 1): Candidate => ({ id, editedAt });
const ids = (rows: readonly { id: string }[]): string[] => rows.map((r) => r.id);

describe('reciprocal rank fusion', () => {
  it('fuses two lists with k = 60: the worked example', () => {
    // Full text: A, B, C. Semantic: C, D, A.  Ranks count from 1.
    //   A = 1/61 + 1/63 = 0.032266   (rank 1 and rank 3)
    //   C = 1/63 + 1/61 = 0.032266   (rank 3 and rank 1): the same sum as A
    //   B = 1/62        = 0.016129   (full text rank 2 only)
    //   D = 1/62        = 0.016129   (semantic rank 2 only): the same as B
    // The ties are broken by the later edit, then the greater id.
    const rows = fuse([c('A', 10), c('B', 30), c('C', 20)], [c('C', 20), c('D', 40), c('A', 10)]);
    expect(RRF_K).toBe(60);
    expect(rows.map((r) => [r.id, Number(r.score.toFixed(6))])).toEqual([
      ['C', 0.032266],
      ['A', 0.032266],
      ['D', 0.016129],
      ['B', 0.016129],
    ]);
    expect(rows.map((r) => [r.id, r.fullTextRank, r.semanticRank])).toEqual([
      ['C', 3, 1],
      ['A', 1, 3],
      ['D', undefined, 2],
      ['B', 2, undefined],
    ]);
    // C before A: the sums are equal and C was edited later (20 over 10); D before B: 40 over 30.
  });

  it('puts a page in both lists above a page in one list at the same rank', () => {
    const rows = fuse([c('only-words'), c('both')], [c('both'), c('only-meaning')]);
    expect(ids(rows)).toEqual(['both', 'only-words', 'only-meaning']);
  });

  it('lets a page in both lists beat a page at rank 1 of one list down to rank 61, ties it at 62 (2 / 122 = 1 / 61: the edit time decides), and loses beyond', () => {
    const filler = (prefix: string, n: number): Candidate[] => Array.from({ length: n }, (_, i) => c(`${prefix}${String(i)}`));
    // 'top-words' is rank 1 of the full-text list only; 'both' is at `rank` in each list, behind other pages.
    const order = (rank: number, bothEditedAt: number) => ids(fuse([c('top-words', 5), ...filler('f', rank - 2), c('both', bothEditedAt)], [...filler('s', rank - 1), c('both', bothEditedAt)]));
    const before = (list: string[], a: string, b: string): boolean => list.indexOf(a) < list.indexOf(b);
    expect(before(order(61, 1), 'both', 'top-words')).toBe(true);
    expect(before(order(62, 1), 'top-words', 'both')).toBe(true); // equal score, the earlier edit is behind
    expect(before(order(62, 9), 'both', 'top-words')).toBe(true); // equal score, the later edit is ahead
    expect(before(order(63, 9), 'top-words', 'both')).toBe(true);
  });

  it('breaks a tie of the score by the later edit, then by the greater id, and so gives the same order whatever order the rows come in', () => {
    const same = [c('b', 5), c('a', 5), c('c', 9)];
    // Three pages of one list at distinct ranks have distinct scores; ties need two lists: swap the order in each.
    const rows = fuse([same[0]!, same[1]!], [same[1]!, same[0]!]);
    expect(ids(rows)).toEqual(['b', 'a']); // equal score, equal edit: the greater id first
    expect(ids(fuse([c('a', 5), c('b', 7)], [c('b', 7), c('a', 5)]))).toEqual(['b', 'a']); // equal score: the later edit first
    expect(compareFused({ score: 1, editedAt: 1, id: 'x' }, { score: 1, editedAt: 1, id: 'x' })).toBe(0);
  });

  it('gives the full-text order unchanged for an empty semantic list, and the semantic order unchanged for an empty full-text list', () => {
    const list = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id, i) => c(id, 100 - i));
    expect(ids(fuse(list, []))).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(ids(fuse([], list))).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(fuse([], [])).toEqual([]);
    expect(fuse(list, [])[0]).toMatchObject({ fullTextRank: 1, semanticRank: undefined, score: 1 / 61 });
  });

  it('names a page once, and a page that a list names twice keeps its better place', () => {
    const rows = fuse([c('a'), c('b'), c('a')], [c('b'), c('b')]);
    expect(ids(rows)).toEqual(['b', 'a']);
    expect(rows.find((r) => r.id === 'a')?.fullTextRank).toBe(1);
    expect(rows.find((r) => r.id === 'b')?.semanticRank).toBe(1);
  });
});

describe('the page of the fused order, and the cursor', () => {
  // 120 fused rows: 70 pages from the words and 70 from meaning, 20 of them in both.
  // The cursor only takes ids that are UUIDs.
  const uuid = (kind: string, n: number): string => `${kind}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const full = Array.from({ length: 70 }, (_, i) => c(uuid('a', i), 1000 - i));
  const semantic = [...Array.from({ length: 20 }, (_, i) => c(uuid('a', i * 3), 1000 - i * 3)), ...Array.from({ length: 50 }, (_, i) => c(uuid('b', i), 500 - i))];
  const fused = fuse(full, semantic);

  it('has 120 distinct rows in a total order', () => {
    expect(fused).toHaveLength(120);
    expect(new Set(ids(fused)).size).toBe(120);
    for (let i = 1; i < fused.length; i += 1) expect(compareFused(fused[i - 1]!, fused[i]!)).toBeLessThan(0);
  });

  it('returns each of the 120 rows once through three requests of 50, 50 and 20, with the cursor that is encoded and decoded between them', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (let request = 0; request < 5; request += 1) {
      // Each request fuses again from the same two lists and finds its place by the key of the cursor.
      const key = cursor === undefined ? undefined : decodeSearchCursor(cursor);
      const page = pageOf(fuse(full, semantic), key === undefined ? undefined : { score: key.rank, editedAt: key.editedAt, id: key.id }, 50);
      sizes.push(page.rows.length);
      seen.push(...ids(page.rows));
      const last = page.rows.at(-1);
      if (!page.more || last === undefined) break;
      cursor = encodeSearchCursor({ rank: last.score, editedAt: last.editedAt, id: last.id });
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(seen).toEqual(ids(fused));
    expect(new Set(seen).size).toBe(120);
  });

  it('says there is no more after the last row, and has nothing after a key past the end or for no rows', () => {
    expect(pageOf(fused, undefined, 120).more).toBe(false);
    expect(pageOf(fused, undefined, 119).more).toBe(true);
    const last = fused.at(-1) as FusedRow;
    expect(pageOf(fused, last, 10)).toEqual({ rows: [], more: false });
    expect(pageOf([], undefined, 10)).toEqual({ rows: [], more: false });
  });

  it('keeps its place when a row ties with the key of the cursor on the score and the edit time: the id decides', () => {
    const rows = fuse([c('a', 5), c('b', 5)], [c('b', 5), c('a', 5)]); // equal score, equal edit: b, then a
    expect(ids(rows)).toEqual(['b', 'a']);
    expect(ids(pageOf(rows, rows[0], 10).rows)).toEqual(['a']);
  });
});

describe('the best chunk of each page', () => {
  const chunk = (pageId: string, chunkIndex: number, similarity: number, editedAt = 1): ChunkMatch => ({ pageId, chunkIndex, similarity, editedAt });

  it('keeps one chunk for each page, the nearest, and lists the pages by that chunk, whatever order the chunks came in', () => {
    const chunks = [chunk('a', 0, 0.7), chunk('b', 0, 0.9), chunk('a', 1, 0.8), chunk('c', 0, 0.85), chunk('b', 3, 0.5)];
    const best = bestChunkPerPage(chunks, 10);
    expect(best.map((b) => [b.pageId, b.chunkIndex])).toEqual([
      ['b', 0],
      ['c', 0],
      ['a', 1],
    ]);
    expect(bestChunkPerPage([...chunks].reverse(), 10)).toEqual(best);
  });

  it('keeps the lower chunk index of a page for equal similarity, and orders equal pages by the later edit then the greater id', () => {
    expect(bestChunkPerPage([chunk('a', 5, 0.8), chunk('a', 2, 0.8)], 5)[0]?.chunkIndex).toBe(2);
    const best = bestChunkPerPage([chunk('a', 0, 0.8, 1), chunk('b', 0, 0.8, 9), chunk('c', 0, 0.8, 9), chunk('d', 0, 0.9, 0)], 10);
    expect(best.map((b) => b.pageId)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('orders pages of equal similarity and equal edit by the greater id, whatever order they come in', () => {
    const pages = ['a', 'b', 'c', 'd', 'e'].map((id) => chunk(id, 0, 0.8, 4));
    expect(bestChunkPerPage(pages, 10).map((b) => b.pageId)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(bestChunkPerPage([...pages].reverse(), 10).map((b) => b.pageId)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(bestChunkPerPage([pages[2]!, pages[0]!, pages[4]!, pages[1]!, pages[3]!], 10).map((b) => b.pageId)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('takes at most `limit` pages, the nearest', () => {
    const chunks = Array.from({ length: 30 }, (_, i) => chunk(`p${String(i)}`, 0, i / 100));
    const best = bestChunkPerPage(chunks, 5);
    expect(best.map((b) => b.pageId)).toEqual(['p29', 'p28', 'p27', 'p26', 'p25']);
    expect(bestChunkPerPage([], 5)).toEqual([]);
  });
});
