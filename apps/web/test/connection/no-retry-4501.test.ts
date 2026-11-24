import { describe, expect, it } from 'vitest';
import { ConnectionManager } from '../../src/editor/core/connection';
import { flush, harness } from '../editor/support';

const open = async () => {
  const h = harness();
  const manager = new ConnectionManager(h.options);
  manager.start();
  await flush();
  return { h, manager, p: h.last().provider };
};

describe('seed-failed (close code 4501) is never retried', () => {
  it('makes no attempt for ten minutes of fake time and shows the page-cannot-be-opened state, whether it arrives as a refusal or as a close', async () => {
    for (const signal of [(p: Awaited<ReturnType<typeof open>>['p']) => p.refuse('seed-failed'), (p: Awaited<ReturnType<typeof open>>['p']) => p.close(4501)]) {
      const { h, manager, p } = await open();
      signal(p);
      expect(manager.state()).toMatchObject({ phase: 'stopped', stopped: 'cannot-open', text: "This page can't be opened right now. Trying again." });
      await h.clock.advance(10 * 60_000);
      expect(p.connects).toBe(1);
      expect(h.clock.pendingCount()).toBe(0);
    }
  });

  it('a press of Retry makes exactly one attempt, and a failure of that attempt is shown again, not retried by itself', async () => {
    const { h, manager, p } = await open();
    p.refuse('seed-failed');
    manager.retry();
    expect(p.connects).toBe(2);
    expect(manager.state().phase).toBe('connecting');
    p.refuse('seed-failed'); // the Markdown still cannot become a document
    expect(manager.state()).toMatchObject({ phase: 'stopped', stopped: 'cannot-open' });
    await h.clock.advance(10 * 60_000);
    expect(p.connects).toBe(2);
    manager.retry();
    expect(p.connects).toBe(3); // each press is one attempt
  });

  it('a press of Retry is one attempt for any refusal: a different one that would be retried by itself is not, this time', async () => {
    const { h, manager, p } = await open();
    p.refuse('seed-failed');
    manager.retry();
    await flush();
    p.refuse('internal-error'); // would be retried after 30 s if it came on its own
    expect(manager.state()).toMatchObject({ phase: 'stopped', stopped: 'cannot-open' });
    expect(h.clock.pendingCount()).toBe(0);
  });

  it('a press of Retry when nothing stopped does nothing', async () => {
    const { manager, p } = await open();
    manager.retry();
    expect(p.connects).toBe(1);
  });

  it('1006 and 4429 follow the backoff while 4501 does not', async () => {
    const { h, p } = await open();
    p.close(1006);
    expect(h.clock.nextIn()).toBe(2000);
    await h.clock.advance(2000);
    expect(p.connects).toBe(2);
    p.close(4429, 'rate-limited');
    expect(h.clock.nextIn()).toBe(30_000);
    await h.clock.advance(30_000);
    expect(p.connects).toBe(3);
  });
});
