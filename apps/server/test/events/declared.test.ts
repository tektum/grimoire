import { describe, expect, it } from 'vitest';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';

function make() {
  const logger = new FakeLogger();
  return { logger, log: createEventLog(logger) };
}

describe('milestone 4 events', () => {
  it('logs each at its level with only the declared fields', () => {
    const { logger, log } = make();
    log.debug('http.request', { method: 'GET', route: '/v1/pages/{id}', status: 200, ms: 3 });
    log.debug('http.validation_failed', { route: '/v1/pages', issues: 2 });
    log.warn('http.rate_limited', { scope: 'user', route: '/v1/pages' });
    log.warn('http.auth_rejected', { reason: 'suspended' });
    log.warn('users.refused', { reason: 'domain-not-allowed' });
    log.warn('config.collab_url_missing', {});
    log.info('http.idempotent_replay', { route: '/v1/pages' });
    log.info('collections.created', { collectionId: 'c1' });
    log.info('collections.deleted', { collectionId: 'c1' });
    log.info('collections.access_changed', { collectionId: 'c1' });
    for (const event of ['pages.created', 'pages.moved', 'pages.deleted', 'pages.restored'] as const) log.info(event, { pageId: 'p1' });
    log.info('pages.purged', { pageId: 'p1', count: 4 });
    log.info('pages.state_reset', { pageId: 'p1', epoch: 2 });
    log.info('admin.user_changed', { userId: 'u1' });
    log.info('admin.group_changed', { groupId: 'g1' });
    expect(logger.entries.map((e) => `${e.level} ${e.event}`)).toEqual([
      'debug http.request', 'debug http.validation_failed', 'warn http.rate_limited', 'warn http.auth_rejected', 'warn users.refused', 'warn config.collab_url_missing',
      'info http.idempotent_replay', 'info collections.created', 'info collections.deleted', 'info collections.access_changed',
      'info pages.created', 'info pages.moved', 'info pages.deleted', 'info pages.restored', 'info pages.purged', 'info pages.state_reset',
      'info admin.user_changed', 'info admin.group_changed',
    ]);
    expect(logger.entries.find((e) => e.event === 'pages.purged')?.fields).toEqual({ pageId: 'p1', count: 4 });
  });

  it('refuses an undeclared field, a wrong scope and an event at the wrong level', () => {
    const { log } = make();
    const call = () => {
      // @ts-expect-error a title is not a declared field
      log.info('pages.created', { pageId: 'p1', title: 'secret' });
      // @ts-expect-error the scope is user, address or route
      log.warn('http.rate_limited', { scope: 'planet', route: '/x' });
      // @ts-expect-error pages.purged is an info event
      log.debug('pages.purged', { pageId: 'p1', count: 1 });
    };
    expect(call).toBeTypeOf('function');
  });
});
