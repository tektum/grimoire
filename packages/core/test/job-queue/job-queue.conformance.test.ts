import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../../src/testing/fake-database.js';
import { FakeJobQueue } from '../../src/testing/fake-job-queue.js';
import { jobQueueCaseNames, jobQueueConformance, type JobQueueHarness } from '../../src/testing/job-queue-conformance.js';

function harness(): JobQueueHarness {
  const database = new FakeDatabase();
  const queue = new FakeJobQueue(database);
  return { queue, database, advance: (s, until) => queue.advance(s, until), crashWorkers: async () => { queue.crashWorkers(); return queue; } };
}

describe('FakeJobQueue conformance (same cases as the pg-boss adapter)', () => {
  it('lists the cases, in order', () => {
    expect(jobQueueConformance.map((c) => c.name)).toEqual([...jobQueueCaseNames]);
    expect([...jobQueueCaseNames]).toEqual([
      'enqueue', 'delay', 'retry', 'crash-rerun', 'singleton-queued-returns-existing', 'singleton-active-visible-to-isLive',
      'handler-gets-attempt-and-signal', 'expiry-aborts-signal', 'stop-waits-then-aborts', 'enqueue-in-rolled-back-tx-creates-no-job', 'schedule-fires-with-data',
    ]);
  });
  for (const c of jobQueueConformance) it(c.name, () => c.run(harness()), 10_000);
});
