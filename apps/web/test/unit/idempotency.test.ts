import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createWebApi } from '../../src/api/client';
import { isIdempotent } from '../../src/api/middleware';

const surface = readFileSync(path.resolve(import.meta.dirname, '../../../../docs/api-surface.txt'), 'utf8').split('\n').filter((l) => l.includes('|'));

function setup(replies: Response[]) {
  const calls: Request[] = [];
  let n = 0;
  const q = [...replies];
  const api = createWebApi({
    baseUrl: 'https://api.example', getToken: async () => 't', refresh: async () => true, signOut: vi.fn(), notify: vi.fn(), reload: vi.fn(), sleep: async () => {}, uuid: () => `k-${++n}`,
    fetch: async (r) => { calls.push(r); return q.shift() ?? new Response('{}', { status: 200 }); },
  });
  return { api, calls };
}
const limited = () => new Response('{"error":{"code":"rate_limited"}}', { status: 429, headers: { 'Retry-After': '1' } });

describe('idempotency keys', () => {
  it('match the idempotent operations of docs/api-surface.txt exactly', () => {
    const fromSurface = surface.filter((l) => l.includes('idem:yes')).map((l) => l.split('|')[0]!.trim()).sort();
    const fromClient = surface.map((l) => l.split('|')[0]!.trim()).filter((sig) => { const [m, p] = sig.split(' ') as [string, string]; return isIdempotent(m, p.replace(/\{[^}]+\}/g, 'x')); }).sort();
    expect(fromClient).toEqual(fromSurface);
    expect(fromSurface.length).toBeGreaterThan(0);
  });
  it('sends a UUID-style key on an idempotent operation and the same key on a retry after 429', async () => {
    const t = setup([limited()]);
    await t.api.POST('/v1/pages' as never, { body: {} } as never);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]?.headers.get('Idempotency-Key')).toBe('k-1');
    expect(t.calls[1]?.headers.get('Idempotency-Key')).toBe('k-1');
  });
  it('uses the same key after a 503 and a new key for a new action', async () => {
    const t = setup([new Response('{"error":{"code":"unavailable"}}', { status: 503 })]);
    await t.api.POST('/v1/collections' as never, { body: {} } as never);
    await t.api.POST('/v1/collections' as never, { body: {} } as never);
    expect(t.calls.map((c) => c.headers.get('Idempotency-Key'))).toEqual(['k-1', 'k-1', 'k-2']);
  });
  it('sends no key for an operation that is not idempotent', async () => {
    const t = setup([]);
    await t.api.PATCH('/v1/pages/{id}' as never, { params: { path: { id: 'p1' } }, body: {} } as never);
    await t.api.GET('/v1/me' as never);
    expect(t.calls.every((c) => !c.headers.has('Idempotency-Key'))).toBe(true);
  });
});
