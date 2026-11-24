import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createCollabLog } from '../../src/events.js';
import { throttleLog } from '../../src/log-throttle.js';

afterEach(() => { vi.useRealTimers(); });
const setup = (maxKeys?: number) => {
  vi.useFakeTimers();
  const logger = new FakeLogger();
  const log = throttleLog(createCollabLog(logger), { windowMs: 10_000, ...(maxKeys ? { maxKeys } : {}) });
  const lines = (event: string) => logger.entries.filter((e) => e.event === event);
  return { logger, log, lines };
};

describe('log throttle', () => {
  it('logs the first occurrence of a kind at once, counts the rest, and writes one summary line when the window ends', async () => {
    const { log, lines } = setup();
    for (let i = 0; i < 5000; i++) log.emit('collab.upgrade_refused', { reason: 'origin', status: 403 });
    expect(lines('collab.upgrade_refused')).toHaveLength(1);
    expect(lines('collab.log_suppressed')).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines('collab.log_suppressed').map((e) => e.fields)).toEqual([{ suppressedEvent: 'collab.upgrade_refused', variant: 'origin', count: 4999, windowSeconds: 10 }]);
    log.emit('collab.upgrade_refused', { reason: 'origin', status: 403 }); // a new window: logged at once again
    expect(lines('collab.upgrade_refused')).toHaveLength(2);
  });

  it('kinds are counted separately: another reason, another refusal code, another limit each log at once', () => {
    const { log, lines } = setup();
    log.emit('collab.upgrade_refused', { reason: 'origin', status: 403 });
    log.emit('collab.upgrade_refused', { reason: 'rate', status: 429 });
    log.emit('collab.refused', { code: 'rate-limited' });
    log.emit('collab.refused', { code: 'state-cap' });
    log.emit('collab.limit_hit', { limit: 'message-rate', value: 301, max: 300 });
    log.emit('collab.limit_hit', { limit: 'state-size', value: 2, max: 1 });
    expect(lines('collab.upgrade_refused')).toHaveLength(2);
    expect(lines('collab.refused')).toHaveLength(2);
    expect(lines('collab.limit_hit')).toHaveLength(2);
  });

  it('alarm-class events are never throttled; reconnect-class events are throttled', () => {
    const { log, lines } = setup();
    for (let i = 0; i < 50; i++) {
      log.emit('collab.store_alarm', { pageId: 'p', consecutive: 5 });
      log.emit('collab.store_failed', { pageId: 'p', attempt: i, consecutive: i, retryInMs: 1, errorName: 'Error' });
      log.emit('collab.connected', { pageId: 'p', accessLevel: 'read-write' });
      log.emit('collab.store_abandoned', { pageId: 'p' });
    }
    expect([lines('collab.store_alarm').length, lines('collab.store_failed').length, lines('collab.connected').length, lines('collab.store_abandoned').length]).toEqual([50, 50, 10, 50]);
  });

  it('100,000 distinct keys: at most 1,000 (+1 shared) slots at any time, and every occurrence is accounted for', async () => {
    const { logger, log, lines } = setup(1000);
    let peak = 0;
    for (let i = 0; i < 100_000; i++) {
      log.emit('collab.state_warning', { pageId: `page-${String(i)}`, stateBytes: 1, maxBytes: 2 });
      peak = Math.max(peak, log.trackedKeys());
    }
    expect(peak).toBeLessThanOrEqual(1001);
    expect(lines('collab.state_warning')).toHaveLength(1000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log.trackedKeys()).toBe(0);
    const counted = lines('collab.log_suppressed').reduce((n, e) => n + Number(e.fields['count']), 0);
    expect(lines('collab.state_warning').length + counted).toBe(100_000);
    expect(logger.entries.length).toBeLessThan(1010);
  });

  it('the log lines carry no address: the fields of a throttled event are the enumerated ones only', () => {
    const { logger, log } = setup();
    log.emit('collab.upgrade_refused', { reason: 'origin', status: 403 });
    expect(Object.keys(logger.entries[0]?.fields ?? {})).toEqual(['reason', 'status']);
  });

  it('1,000 reconnects in a minute write at most the burst per window and a summary line for the rest, never one per reconnect', async () => {
    const { log, lines } = setup();
    for (let i = 0; i < 1000; i++) {
      log.emit('collab.connected', { pageId: 'p', accessLevel: 'read-write' });
      await vi.advanceTimersByTimeAsync(60);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    const written = lines('collab.connected').length;
    expect(written).toBeLessThanOrEqual(70); // a burst of 10 per 10 s window across the minute, not one per reconnect
    const summarised = lines('collab.log_suppressed').reduce((n, e) => n + (typeof e.fields['count'] === 'number' ? e.fields['count'] : 0), 0);
    expect(written + summarised).toBe(1000);
  });
});
