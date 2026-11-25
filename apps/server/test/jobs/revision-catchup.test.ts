import { describe, expect, it, vi } from 'vitest';
import type { RevisionRepo } from '@tektum/grimoire-core/ports/revision-repo';
import { CATCH_UP_IDLE_MS, runRevisionCatchUp } from '../../src/jobs/revision-catchup.js';

const made = (n: number) => Array.from({ length: n }, (_, i) => ({ pageId: `p${String(i)}`, revisionId: `r${String(i)}` }));
const repo = (rounds: number[]) => {
  const catchUp = vi.fn(async (_before: number, limit: number) => made(Math.min(rounds.shift() ?? 0, limit)));
  return { catchUp, revisions: { catchUp } as unknown as RevisionRepo };
};

describe('runRevisionCatchUp', () => {
  it('asks for pages idle for five minutes, in batches of 500, until a batch is not full', async () => {
    const r = repo([500, 500, 7]);
    expect(await runRevisionCatchUp({ revisions: r.revisions, now: () => 1_000_000, batchSize: 500 }, new AbortController().signal)).toBe(1007);
    expect(r.catchUp.mock.calls).toEqual([[1_000_000 - CATCH_UP_IDLE_MS, 500], [1_000_000 - CATCH_UP_IDLE_MS, 500], [1_000_000 - CATCH_UP_IDLE_MS, 500]]);
    expect(CATCH_UP_IDLE_MS).toBe(300_000);
  });

  it('stops between batches when the signal aborts', async () => {
    const stop = new AbortController();
    const r = repo([2, 2, 2]);
    r.catchUp.mockImplementationOnce(async () => { stop.abort(); return made(2); });
    expect(await runRevisionCatchUp({ revisions: r.revisions, now: () => 0, batchSize: 2 }, stop.signal)).toBe(2);
    expect(r.catchUp).toHaveBeenCalledTimes(1);
  });
});
