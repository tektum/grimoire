import { describe, expect, it } from 'vitest';
import { routeReplays } from '../../src/http/replays.js';
import type { Operation } from './document.js';
import { bodyFields, exampleBody, operations } from './document.js';
import { buildWorld, pathFor } from './world.js';
import type { Who } from './world.js';

/**
 * An idempotent route answers a retry from the stored answer, and a stored answer must not outlive the right to see it: access is checked again before a
 * replay (R6.7). The walk finds every idempotent operation in the generated document, requires a replay hook for it in `replays.ts` (or an entry in
 * EXEMPT with its reason), and plays the retry after the caller lost the right.
 */
const idempotent = operations().filter((o) => o.idempotent);
/** Idempotent operations that need no hook, each with the reason. Empty: every one of them creates or changes something that access can be taken away from. */
const EXEMPT: Readonly<Record<string, string>> = {};
const patternOf = (op: Operation): string => `${op.method} ${op.path.replace(/\{(\w+)\}/g, ':$1')}`;
/** The person who may call the operation. */
const callerOf = (op: Operation): Who => (op.policy.kind === 'admin' ? 'admin' : 'member');

describe('the idempotent operations', () => {
  it('are the ones this walk plays', () => {
    expect(idempotent.map((o) => o.key)).toEqual(['POST /v1/collections', 'POST /v1/groups', 'POST /v1/pages', 'POST /v1/pages/{id}/reset-state']);
  });

  it('have a replay hook each, or an exemption with a reason, and no hook is left for a route that is not idempotent', () => {
    for (const op of idempotent) expect(patternOf(op) in routeReplays || op.key in EXEMPT, `${op.key} has no replay hook`).toBe(true);
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(10);
    expect(Object.keys(routeReplays).filter((k) => !idempotent.some((o) => patternOf(o) === k))).toEqual([]);
  });

  describe.each(idempotent.map((o) => [o.key, o] as const))('%s', (_key, op) => {
    const play = async (revoke: 'demote' | 'suspend') => {
      const w = await buildWorld();
      const who = callerOf(op);
      // A collection the walk makes is readable by everyone: a demoted caller can still see it, so only a check of the admin right itself can refuse the retry.
      const readable = bodyFields(op).includes('defaultPermission') ? { defaultPermission: 'read' } : {};
      const body = { ...(exampleBody(op.bodySchema as never, { uuid: w.ids.page, collectionId: w.ids.openCollection }) as object), ...readable };
      const send = () => w.call(who, op.method, pathFor(op, w), body, { 'idempotency-key': `walk-${revoke}` });
      const first = await send();
      expect(first.status, await first.clone().text()).toBeLessThan(300);
      const same = await send();
      expect([same.status, same.headers.get('idempotent-replay')], 'a retry while the right holds').toEqual([first.status, 'true']);
      if (revoke === 'demote') await w.demote(who as 'admin' | 'member');
      else w.suspend(who as 'admin' | 'member');
      return { w, retry: await send() };
    };

    it('replays the stored answer while the caller may still do it, and not after the caller was demoted: 403, the right is checked again, not only the sight of the result', async () => {
      // Whoever was demoted can still read what the walk made (a collection with `defaultPermission: 'read'`, a page in the open collection), so the 403 can only
      // come from a check of the right itself.
      const { retry } = await play('demote');
      expect(retry.headers.get('idempotent-replay')).not.toBe('true');
      expect([retry.status, ((await retry.json()) as { error: { code: string } }).error.code]).toEqual([403, 'forbidden']);
    });

    it('does not replay to a caller who was suspended after the first call', async () => {
      const { retry } = await play('suspend');
      expect(retry.headers.get('idempotent-replay')).not.toBe('true');
      expect([retry.status, ((await retry.json()) as { error: { code: string } }).error.code]).toEqual([403, 'account_suspended']);
    });
  });
});
