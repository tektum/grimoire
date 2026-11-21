import { describe, expect, it } from 'vitest';
import { makeFakeConfig } from '../../src/testing/fake-config.js';
import { FakeClock } from '../../src/testing/fake-clock.js';
import { FakeLogger } from '../../src/testing/fake-logger.js';
import type { Clock } from '../../src/ports/clock.js';
import type { Logger } from '../../src/ports/logger.js';

describe('FakeClock', () => {
  it('advances deterministically and only when told', () => {
    const c: Clock = new FakeClock(1000);
    const fake = c as FakeClock;
    expect(c.now()).toBe(1000);
    expect(c.now()).toBe(1000);
    expect(fake.advance(250)).toBe(1250);
    fake.advance(0);
    expect(c.now()).toBe(1250);
    fake.set(5);
    expect(c.now()).toBe(5);
    expect(new FakeClock().now()).toBe(0);
  });

  it('rejects negative advances', () => {
    expect(() => new FakeClock().advance(-1)).toThrow(RangeError);
  });
});

describe('FakeLogger', () => {
  it('captures structured entries in order', () => {
    const log = new FakeLogger();
    const l: Logger = log;
    l.debug('a');
    l.info('b', { n: 1 });
    l.warn('c');
    l.error('d', { reason: 'x' });
    expect(log.entries).toEqual([
      { level: 'debug', event: 'a', fields: {} },
      { level: 'info', event: 'b', fields: { n: 1 } },
      { level: 'warn', event: 'c', fields: {} },
      { level: 'error', event: 'd', fields: { reason: 'x' } },
    ]);
  });

  it('child loggers add fields and share the entry list', () => {
    const log = new FakeLogger();
    log.child({ page: 'p' }).child({ user: 'u' }).info('e', { k: 1 });
    expect(log.entries).toEqual([{ level: 'info', event: 'e', fields: { page: 'p', user: 'u', k: 1 } }]);
  });
});

describe('makeFakeConfig', () => {
  it('returns a valid local config with merged overrides', () => {
    const c = makeFakeConfig({ port: 1, collab: { banSeconds: 9 } });
    expect(c.local).toBe(true);
    expect(c.port).toBe(1);
    expect(c.collab.banSeconds).toBe(9);
    expect(c.collab.maxConnections).toBe(500);
  });
});
