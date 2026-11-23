import { describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import type { AppOptions } from '../../src/app.js';
import { fail } from '../../src/http/error.js';
import type { AppEnv } from '../../src/http/env.js';
import { defineRoute } from '../../src/http/factory.js';
import { makeContext } from '../server/support/context.js';

const DAY = 24 * 60 * 60 * 1000;
const Ok = z.object({ n: z.number() });
const responses = { 201: { description: 'created', content: { 'application/json': { schema: Ok } } } };

function build(opts: AppOptions = {}) {
  const t = makeContext();
  const verifier: AuthVerifier = { verify: (token) => Promise.resolve({ kind: 'ok', userId: `d${token}`, expiresAt: 9e12 }) };
  const rows: UserRecord[] = ['1', '2'].map((n) => ({ id: `id${n}`, descopeUserId: `d${n}`, email: `p${n}@example.com`, name: 'P', role: 'member' as const, suspended: false }));
  const users = new FakeUserStore(rows);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], allowDevRole: false };
  const provisioner = createProvisioner({ users, verifier, policy: signInPolicy });
  const store = new FakeIdempotencyStore(t.clock);
  const app = createApp({ ...t.ctx, auth: { verifier }, signInPolicy, http: { ...t.ctx.http, users, provisioner, idempotency: store } }, opts);
  const state = { runs: 0, gate: undefined as Promise<void> | undefined, answer: 201, bodies: [] as unknown[] };
  const make = (path: string, idempotent: boolean) => app.openapi(
    defineRoute({ method: 'post', path, summary: 's', tags: ['t'], policy: { kind: 'authenticated' }, idempotent, request: { body: { content: { 'application/json': { schema: z.object({ v: z.number() }) } }, required: true } }, responses: { ...responses, 200: responses[201] } }),
    async (c) => {
      state.runs += 1;
      state.bodies.push(await c.req.json());
      if (state.gate !== undefined) await state.gate;
      if (state.answer >= 500) throw new Error('boom');
      return c.json({ n: state.runs }, state.answer as 201);
    },
  );
  const raw = (path: string, answer: () => Response) => app.post(path, () => answer());
  raw('/v1/text', () => new Response('plain text', { status: 201, headers: { 'content-type': 'text/plain' } }));
  raw('/v1/notype', () => new Response(new Uint8Array([120]), { status: 201 }));
  raw('/v1/badjson', () => new Response('{bad', { status: 201, headers: { 'content-type': 'application/json' } }));
  raw('/v1/empty', () => new Response(null, { status: 204 }));
  raw('/v1/throws', () => { throw 'not an Error'; });
  make('/v1/things', true);
  make('/v1/plain', false);
  app.get('/v1/things', (c) => c.json({ n: 0 }));
  for (const path of ['/v1/text', '/v1/notype', '/v1/badjson', '/v1/empty', '/v1/throws']) app.openAPIRegistry.registerPath({ method: 'post', path, responses: {}, 'x-grimoire-idempotent': true } as never);
  return { app, t, state, store };
}

type Built = ReturnType<typeof build>;
const post = (b: Built, body: unknown, key: string | undefined, token = '1', path = '/v1/things') =>
  b.app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(key === undefined ? {} : { 'idempotency-key': key }) } });
const json = async (res: Response) => (await res.json()) as { n?: number; error?: { code: string } };

describe('idempotency keys', () => {
  it('replays the first status and body with Idempotent-Replay, and the handler runs once', async () => {
    const b = build();
    const first = await post(b, { v: 1 }, 'k1');
    expect(first.status).toBe(201);
    expect(first.headers.get('idempotent-replay')).toBeNull();
    const second = await post(b, { v: 1 }, 'k1');
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replay')).toBe('true');
    expect(second.headers.get('content-type')).toContain('application/json');
    expect(await json(second)).toEqual({ n: 1 });
    expect(b.state.runs).toBe(1);
    expect(b.t.logger.entries.filter((e) => e.event === 'http.idempotent_replay').map((e) => e.fields)).toEqual([{ route: '/v1/things' }]);
  });

  it('answers 409 conflict for the same key with another body', async () => {
    const b = build();
    await post(b, { v: 1 }, 'k1');
    const res = await post(b, { v: 2 }, 'k1');
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe('conflict');
    expect(b.state.runs).toBe(1);
  });

  it('runs the handler once for two simultaneous first requests; the other gets 409 conflict', async () => {
    const b = build();
    let release: () => void = () => undefined;
    b.state.gate = new Promise<void>((resolve) => { release = resolve; });
    const first = post(b, { v: 1 }, 'k1');
    await Promise.resolve();
    await new Promise((resolve) => { setImmediate(resolve); });
    const second = await post(b, { v: 1 }, 'k1');
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(201);
    expect(b.state.runs).toBe(1);
    expect((await post(b, { v: 1 }, 'k1')).headers.get('idempotent-replay')).toBe('true');
  });

  it('keeps keys apart per user', async () => {
    const b = build();
    await post(b, { v: 1 }, 'k1', '1');
    const other = await post(b, { v: 1 }, 'k1', '2');
    expect(other.headers.get('idempotent-replay')).toBeNull();
    expect(b.state.runs).toBe(2);
  });

  it('treats the key as optional, and ignores it on routes not declared idempotent and on a GET', async () => {
    const b = build();
    await post(b, { v: 1 }, undefined);
    await post(b, { v: 1 }, undefined);
    expect(b.state.runs).toBe(2);
    await post(b, { v: 1 }, 'k', '1', '/v1/plain');
    await post(b, { v: 1 }, 'k', '1', '/v1/plain');
    expect(b.state.runs).toBe(4);
    const get = () => b.app.request('/v1/things', { headers: { authorization: 'Bearer 1', 'idempotency-key': 'g' } });
    expect((await get()).headers.get('idempotent-replay')).toBeNull();
    expect((await get()).headers.get('idempotent-replay')).toBeNull();
    expect(b.store.size).toBe(0);
  });

  it('refuses a malformed key with 422 invalid before anything runs', async () => {
    const b = build();
    for (const key of ['', 'has space', 'é', 'x'.repeat(256)]) {
      const res = await post(b, { v: 1 }, key);
      expect(res.status, key).toBe(422);
    }
    expect(b.state.runs).toBe(0);
  });

  it('frees the key after a failure, so the same key can be sent again', async () => {
    const b = build();
    b.state.answer = 500;
    expect((await post(b, { v: 1 }, 'k1')).status).toBe(503);
    b.state.answer = 201;
    const again = await post(b, { v: 1 }, 'k1');
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replay')).toBeNull();
    expect(b.state.runs).toBe(2);
  });

  it('frees the key after a validation refusal, so a corrected body can use it', async () => {
    const b = build();
    expect((await post(b, { v: 'x' }, 'k1')).status).toBe(422);
    expect((await post(b, { v: 1 }, 'k1')).status).toBe(201);
  });

  it('removes keys older than 24 hours when the sampled request cleans up, and the key is usable again', async () => {
    let clean = false;
    const b = build({ idempotencySample: () => clean });
    await post(b, { v: 1 }, 'old');
    b.t.clock.advance(DAY + 1);
    await post(b, { v: 1 }, 'recent');
    expect(b.store.size).toBe(2);
    clean = true;
    await post(b, { v: 1 }, 'trigger');
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(b.store.size).toBe(2);
    clean = false;
    const reused = await post(b, { v: 1 }, 'old');
    expect(reused.headers.get('idempotent-replay')).toBeNull();
    expect(b.state.runs).toBe(4);
  });

  it('does not let a failing clean-up touch the request', async () => {
    const b = build({ idempotencySample: () => true });
    b.store.deleteCreatedBefore = () => Promise.reject(new Error('db down'));
    expect((await post(b, { v: 1 }, 'k1')).status).toBe(201);
  });
});

describe('answers that are not kept', () => {
  it.each(['/v1/text', '/v1/notype', '/v1/badjson'])('does not keep %s (not replayable JSON): the key is freed and the request runs again', async (path) => {
    const b = build();
    const first = await post(b, {}, 'k', '1', path);
    expect(first.status).toBe(201);
    expect(b.store.size).toBe(0);
    expect((await post(b, {}, 'k', '1', path)).headers.get('idempotent-replay')).toBeNull();
  });

  it('keeps and replays an answer with no body', async () => {
    const b = build();
    expect((await post(b, {}, 'k', '1', '/v1/empty')).status).toBe(204);
    const replay = await post(b, {}, 'k', '1', '/v1/empty');
    expect(replay.status).toBe(204);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(await replay.text()).toBe('');
  });

  it('frees the key when the handler throws something that is not an Error, and the answer is still 503', async () => {
    const b = build();
    expect((await post(b, {}, 'k', '1', '/v1/throws')).status).toBe(503);
    expect(b.store.size).toBe(0);
  });

  it('still answers when the answer cannot be recorded', async () => {
    const b = build();
    b.store.complete = () => Promise.reject(new Error('db down'));
    expect((await post(b, { v: 1 }, 'k')).status).toBe(201);
  });
});

describe('replay rebuild hook', () => {
  const rebuilt = (hook: NonNullable<AppOptions['replayRebuild']>[string]) => build({ replayRebuild: { 'POST /v1/things': hook } });

  it('answers a replay with what the hook returns, given the stored status and body, and marks it a replay', async () => {
    const seen: unknown[] = [];
    const b = rebuilt((stored, c: Context<AppEnv>) => {
      seen.push(stored, c.get('user')?.id);
      return c.json({ n: 99, again: true }, 200);
    });
    await post(b, { v: 1 }, 'k1');
    const replay = await post(b, { v: 1 }, 'k1');
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(await replay.json()).toEqual({ n: 99, again: true });
    expect(seen).toEqual([{ status: 201, body: { n: 1 } }, 'id1']);
    expect(b.state.runs).toBe(1);
  });

  it('lets the hook refuse the replay with an error of the envelope', async () => {
    const b = rebuilt(() => fail('conflict'));
    await post(b, { v: 1 }, 'k1');
    const replay = await post(b, { v: 1 }, 'k1');
    expect(replay.status).toBe(409);
    expect((await json(replay)).error?.code).toBe('conflict');
  });

  it('does not call the hook for the first request, and replays as stored without one', async () => {
    let calls = 0;
    const b = rebuilt((stored) => { calls += 1; return new Response(null, { status: stored.status }); });
    expect((await post(b, { v: 1 }, 'k1')).status).toBe(201);
    expect(calls).toBe(0);
    const plain = build();
    await post(plain, { v: 1 }, 'k1');
    expect(await json(await post(plain, { v: 1 }, 'k1'))).toEqual({ n: 1 });
  });
});
