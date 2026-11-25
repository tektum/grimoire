import { describe, expect, it } from 'vitest';
import { jobQueues, scheduleKey } from '../../src/jobs/queues.js';

const byName = (queues = jobQueues()) => new Map(queues.map((q) => [q.name, q]));

describe('jobQueues', () => {
  it('lists the queues of the contract with their policy and expiry', () => {
    expect(jobQueues().map((q) => [q.name, q.policy, q.expireInSeconds])).toEqual([
      ['dead-letter', 'standard', 600],
      ['import', 'stately', 900],
      ['import-sweep', 'stately', 300],
      ['import-cleanup', 'stately', 600],
      ['purge', 'stately', 3600],
      ['upload-cleanup', 'stately', 600],
      ['revision-catchup', 'stately', 1800],
      ['markdown-sweep', 'stately', 300],
      ['embed-sweep', 'stately', 300],
      ['embed-page', 'stately', 600],
    ]);
  });

  it('retries three times with growing delay and sends the exhausted jobs to the dead-letter queue, which has none of its own', () => {
    const queues = byName();
    for (const [name, q] of queues) {
      expect({ name, retryLimit: q.retryLimit, delay: q.retryDelaySeconds, backoff: q.retryBackoff, retention: q.retentionSeconds }).toEqual({ name, retryLimit: 3, delay: 30, backoff: true, retention: 14 * 86400 });
      expect(q.deadLetter).toBe(name === 'dead-letter' ? undefined : 'dead-letter');
    }
  });

  it('puts the dead-letter queue first, because a queue can only name a dead-letter queue that exists', () => {
    expect(jobQueues()[0]?.name).toBe('dead-letter');
  });

  it('takes the import expiry from the setting', () => {
    expect(byName(jobQueues(20)).get('import')?.expireInSeconds).toBe(20);
    expect(byName(jobQueues(20)).get('import-cleanup')?.expireInSeconds).toBe(600);
  });

  it('names the next run of a schedule `sched:<queue>`: the key is stored in the queue\'s rows, so a new form would leave the runs that wait under the old one behind at a deploy', () => {
    expect(['purge', 'embed-sweep'].map(scheduleKey)).toEqual(['sched:purge', 'sched:embed-sweep']);
  });
});
