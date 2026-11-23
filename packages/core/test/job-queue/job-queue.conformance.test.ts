import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../../src/testing/fake-database.js';
import { FakeJobQueue } from '../../src/testing/fake-job-queue.js';
import { jobQueueCaseNames, jobQueueConformance, type JobQueueHarness } from '../../src/testing/job-queue-conformance.js';

function harness(): JobQueueHarness {
  const database = new FakeDatabase();
  const queue = new FakeJobQueue(database);
  return { queue, database, advance: (s) => queue.advance(s), crashWorkers: async () => queue.crashWorkers() };
}

describe('FakeJobQueue conformance (same cases as the pg-boss adapter)', () => {
  it('lists the seven cases, in order', () => {
    expect(jobQueueConformance.map((c) => c.name)).toEqual([...jobQueueCaseNames]);
    expect([...jobQueueCaseNames]).toEqual(['enqueue', 'delay', 'retry', 'singleton', 'schedule', 'crash-rerun', 'rolled-back-enqueue']);
  });
  for (const c of jobQueueConformance) it(c.name, () => c.run(harness()), 5000);
});
