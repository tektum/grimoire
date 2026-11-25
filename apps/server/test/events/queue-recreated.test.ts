import { describe, expect, it } from 'vitest';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';

describe('jobs.queue_recreated', () => {
  it('is a warning with the queue, both policies and the counts of what was dropped, and no payload', () => {
    const logger = new FakeLogger();
    createEventLog(logger).warn('jobs.queue_recreated', { queue: 'purge', from: 'singleton', to: 'stately', pending: 1, finished: 4 });
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({ level: 'warn', event: 'jobs.queue_recreated', fields: { queue: 'purge', from: 'singleton', to: 'stately', pending: 1, finished: 4 } });
  });
});
