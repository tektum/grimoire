import { describe, expect, it } from 'vitest';
import { ConnectionManager } from '../../src/editor/core/connection';
import { TEXTS } from '../../src/editor/core/map-signal';
import { flush, harness } from '../editor/support';

const open = async () => {
  const h = harness();
  const manager = new ConnectionManager(h.options);
  manager.start();
  await flush();
  return { h, manager, p: h.last().provider };
};

describe('what is not retried, and how fast the rest is', () => {
  it('a refusal seed-failed schedules no reconnect in ten minutes and shows the message with its button', async () => {
    const { h, manager, p } = await open();
    p.refuse('seed-failed');
    await h.clock.advance(10 * 60_000);
    expect(p.connects).toBe(1);
    expect(manager.state()).toMatchObject({ stopped: 'cannot-open', text: TEXTS.cannotOpen });
  });

  it('upgrade-style failures (close 1006 without a reason) retry first after at least 2 s, never faster than the backoff table', async () => {
    const { h, p } = await open();
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      p.close(1006);
      waits.push(h.clock.nextIn()!);
      await h.clock.advance(h.clock.nextIn()!);
    }
    expect(waits[0]).toBeGreaterThanOrEqual(2000);
    expect(waits).toEqual([2000, 2000, 4000, 8000, 16000]); // the table: 1, 2, 4, 8, 16 s, with the 2 s floor on the first two
    for (const [i, wait] of waits.entries()) expect(wait).toBeGreaterThanOrEqual(Math.min(30_000, 1000 * 2 ** i));
  });

  it('a stateless rate-limited followed by the close 4429 is one BUSY event: one notice and one 30 s wait', async () => {
    const { h, manager, p } = await open();
    const notices: (string | null)[] = [];
    manager.subscribe((s) => notices.push(s.notice));
    const changes = () => notices.filter((n, i) => n !== null && n !== notices[i - 1]); // each time a notice appears or changes
    p.stateless({ kind: 'refusal', code: 'rate-limited' });
    p.close(4429, 'rate-limited');
    expect(changes()).toEqual([TEXTS.rateLimitedNotice]); // one notice, not one per signal
    expect(h.clock.pendingCount()).toBe(1); // one wait
    expect(h.clock.nextIn()).toBe(30_000);
    await h.clock.advance(29_999);
    expect(p.connects).toBe(1);
    await h.clock.advance(1);
    expect(p.connects).toBe(2);
    expect(manager.state().text).toBe(TEXTS.rateLimited);
  });

  it('the other ERROR refusals retry every 30 s, three times, and then stop with a button; a sync starts the count over', async () => {
    const { h, manager, p } = await open();
    for (let i = 0; i < 3; i++) {
      p.refuse('internal-error');
      expect(h.clock.nextIn()).toBe(30_000);
      await h.clock.advance(30_000);
    }
    expect(p.connects).toBe(4);
    p.refuse('internal-error');
    expect(manager.state()).toMatchObject({ phase: 'stopped', stopped: 'cannot-open' });
    expect(h.clock.pendingCount()).toBe(0);
    manager.retry();
    await flush(); // the token of the new attempt is read
    p.succeed(1);
    p.refuse('internal-error');
    expect(h.clock.nextIn()).toBe(30_000); // the count restarted after the sync
  });

  it('bad-document-name is a client bug: no retry at all', async () => {
    const { h, manager, p } = await open();
    p.refuse('bad-document-name');
    expect(manager.state()).toMatchObject({ stopped: 'cannot-open', text: TEXTS.badDocumentName });
    await h.clock.advance(60 * 60_000);
    expect(p.connects).toBe(1);
  });
});
