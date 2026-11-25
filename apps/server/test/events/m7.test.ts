import { describe, expect, it } from 'vitest';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';

// M7-T00 (contracts section 6): every event of the milestone is declared here so that no later task edits `events.ts`. Ids, counts and reason codes only.
describe('milestone 7 events', () => {
  it('logs each at its level with only the declared fields', () => {
    const logger = new FakeLogger();
    const log = createEventLog(logger);
    log.info('jobs.started', { name: 'purge', jobId: 'j1', attempt: 1, ms: 0 });
    log.info('jobs.completed', { name: 'purge', jobId: 'j1', attempt: 1, ms: 5 });
    log.warn('jobs.retrying', { name: 'purge', jobId: 'j1', attempt: 1, ms: 5, errorName: 'Error', errorMessage: 'x' });
    log.error('jobs.failed', { name: 'purge', jobId: 'j1', attempt: 3, ms: 5, errorName: 'Error', errorMessage: 'x' });
    log.warn('jobs.aborted', { name: 'purge', jobId: 'j1' });
    log.info('jobs.stopped', { inFlight: 0 });
    log.debug('search.query', { ms: 4, results: 3 });
    log.warn('search.timeout', {});
    log.info('import.created', { importId: 'i1' });
    log.info('import.started', { importId: 'i1' });
    log.info('import.progress', { importId: 'i1', pagesDone: 2, pagesTotal: 9 });
    log.info('import.finished', { importId: 'i1', ok: 8, skipped: 1, failed: 0 });
    log.warn('import.failed', { importId: 'i1', reason: 'invalid_archive' });
    log.info('import.cancelled', { importId: 'i1' });
    log.info('import.swept', { importId: 'i1', action: 'expired' });
    log.warn('import.archive_refused', { importId: 'i1', reason: 'too_many_entries' });
    log.warn('import.item_failed', { importId: 'i1', kind: 'page', reason: 'too_large' });
    log.info('purge.completed', { pages: 3, objects: 4 });
    expect(logger.entries.map((e) => `${e.level} ${e.event}`)).toEqual([
      'info jobs.started', 'info jobs.completed', 'warn jobs.retrying', 'error jobs.failed', 'warn jobs.aborted', 'info jobs.stopped', 'debug search.query', 'warn search.timeout',
      'info import.created', 'info import.started', 'info import.progress', 'info import.finished', 'warn import.failed', 'info import.cancelled', 'info import.swept',
      'warn import.archive_refused', 'warn import.item_failed', 'info purge.completed',
    ]);
    expect(logger.entries.at(-1)?.fields).toEqual({ pages: 3, objects: 4 });
  });
});
