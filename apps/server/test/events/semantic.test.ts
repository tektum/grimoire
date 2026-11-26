import { describe, expect, it } from 'vitest';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';

// M7-T11 (contracts section 15.6): the events of the semantic search. Ids, counts, model names and reason codes only: no page text, query text or vector is ever a field.
describe('the semantic events', () => {
  it('are logged at their levels with only the declared fields', () => {
    const logger = new FakeLogger();
    const log = createEventLog(logger);
    log.info('semantic.embedded', { pageId: 'p1', chunks: 4, reused: 3, ms: 120 });
    log.warn('semantic.failed', { pageId: 'p1', reason: 'too-long', attempt: 2 });
    log.error('semantic.unavailable', { reason: 'model-missing' });
    log.info('semantic.reembed_started', { model: 'multilingual-e5-base@1a2b3c4d', pages: 40 });
    log.warn('semantic.reembed_count_failed', { errorName: 'Error', errorMessage: 'connection down' });
    log.debug('search.semantic_fallback', { reason: 'embedder-unavailable' });
    expect(logger.entries.map((e) => `${e.level} ${e.event}`)).toEqual([
      'info semantic.embedded', 'warn semantic.failed', 'error semantic.unavailable', 'info semantic.reembed_started', 'warn semantic.reembed_count_failed', 'debug search.semantic_fallback',
    ]);
    expect(logger.entries[2]?.fields).toEqual({ reason: 'model-missing' });
  });

  it('name every reason the embedder can be unavailable for', () => {
    const logger = new FakeLogger();
    const log = createEventLog(logger);
    for (const reason of ['model-missing', 'model-hash-mismatch', 'load-failed', 'runtime-failed'] as const) log.error('semantic.unavailable', { reason });
    expect(logger.entries.map((e) => (e.fields as { reason: string }).reason)).toEqual(['model-missing', 'model-hash-mismatch', 'load-failed', 'runtime-failed']);
  });
});
