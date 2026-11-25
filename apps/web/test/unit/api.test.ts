import { describe, expect, it, vi } from 'vitest';
import { createWebApi } from '../../src/api/client';
import { MESSAGES, messageFor } from '../../src/api/messages';
import { retryAfterSeconds } from '../../src/api/middleware';

const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const err = (status: number, code: string, headers?: Record<string, string>) => json(status, { error: { code } }, headers);

function setup(replies: (Response | Error)[], refreshResult = true) {
  const calls: Request[] = [];
  const queue = [...replies];
  const hooks = { refresh: vi.fn(async () => refreshResult), signOut: vi.fn(), notify: vi.fn(), reload: vi.fn(), sleep: vi.fn(async () => {}) };
  let token = 'old';
  hooks.refresh.mockImplementation(async () => {
    token = 'new';
    return refreshResult;
  });
  let n = 0;
  const api = createWebApi({
    baseUrl: 'https://api.example',
    getToken: async () => token,
    fetch: async (r) => {
      calls.push(r);
      const next = queue.shift() ?? json(200);
      if (next instanceof Error) throw next;
      return next;
    },
    uuid: () => `uuid-${++n}`,
    ...hooks,
  });
  return { api, calls, ...hooks };
}

describe('API wrapper', () => {
  it('sends the bearer token and client version, and never credentials', async () => {
    const t = setup([json(200)]);
    await t.api.GET('/v1/me' as never);
    expect(t.calls[0]?.headers.get('Authorization')).toBe('Bearer old');
    expect(t.calls[0]?.headers.get('X-Grimoire-Client-Version')).toBe('0.0.0');
    expect(t.calls[0]?.credentials).toBe('omit');
  });
  it('refreshes once after a 401 and retries with the new token (two calls, one refresh)', async () => {
    const t = setup([err(401, 'unauthenticated'), json(200)]);
    const r = await t.api.GET('/v1/me' as never);
    expect(r.response.status).toBe(200);
    expect(t.calls).toHaveLength(2);
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(t.calls[1]?.headers.get('Authorization')).toBe('Bearer new');
  });
  it('signs out as expired after a second 401', async () => {
    const t = setup([err(401, 'unauthenticated'), err(401, 'unauthenticated')]);
    await t.api.GET('/v1/me' as never);
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(t.signOut).toHaveBeenCalledWith('expired');
  });
  it('signs out when the refresh fails', async () => {
    const t = setup([err(401, 'unauthenticated')], false);
    await t.api.GET('/v1/me' as never);
    expect(t.signOut).toHaveBeenCalledWith('expired');
  });
  it('signs out for account_suspended and not_allowed', async () => {
    const a = setup([err(403, 'account_suspended')]);
    await a.api.GET('/v1/me' as never);
    expect(a.signOut).toHaveBeenCalledWith('suspended');
    const b = setup([err(403, 'not_allowed')]);
    await b.api.GET('/v1/me' as never);
    expect(b.signOut).toHaveBeenCalledWith('not-allowed');
  });
  it('retries a GET after Retry-After seconds with a notice', async () => {
    const t = setup([err(429, 'rate_limited', { 'Retry-After': '2' }), json(200)]);
    const r = await t.api.GET('/v1/me' as never);
    expect(r.response.status).toBe(200);
    expect(t.sleep).toHaveBeenCalledWith(2000);
    expect(t.notify).toHaveBeenCalledWith('Slow down, trying again in 2 seconds');
  });
  it('does not retry a write without an idempotency key after 429', async () => {
    const t = setup([err(429, 'rate_limited', { 'Retry-After': '2' })]);
    await t.api.PATCH('/v1/pages/{id}' as never, { params: { path: { id: 'p1' } }, body: {} } as never);
    expect(t.calls).toHaveLength(1);
    expect(t.sleep).not.toHaveBeenCalled();
    expect(t.notify).toHaveBeenCalledWith('Too many requests. Try again in a moment');
    expect(t.notify).not.toHaveBeenCalledWith(expect.stringContaining('trying again'));
  });
  it('waits for the Retry-After of a 503 before retrying a GET, and falls back to the backoff without one', async () => {
    const a = setup([err(503, 'unavailable', { 'Retry-After': '5' }), json(200)]);
    const ra = await a.api.GET('/v1/me' as never);
    expect(a.sleep).toHaveBeenCalledWith(5000);
    expect([a.calls.length, ra.response.status]).toEqual([2, 200]);
    const b = setup([err(503, 'unavailable'), json(200)]);
    const rb = await b.api.GET('/v1/me' as never);
    expect(b.sleep).toHaveBeenCalledWith(1000);
    expect([b.calls.length, rb.response.status]).toEqual([2, 200]);
    const c = setup([err(503, 'unavailable', { 'Retry-After': '999' }), json(200)]);
    const rc = await c.api.GET('/v1/me' as never);
    expect(c.sleep).toHaveBeenCalledWith(30000);
    expect([c.calls.length, rc.response.status]).toEqual([2, 200]);
  });
  it('caps the wait at 30 s and the retries at 3', async () => {
    const t = setup(Array.from({ length: 6 }, () => err(429, 'rate_limited', { 'Retry-After': '999' })));
    await t.api.GET('/v1/me' as never);
    expect(t.calls).toHaveLength(4);
    expect(t.sleep).toHaveBeenCalledWith(30000);
  });
  it('retries a GET with backoff 1, 2, 4 s on 503 and on network failure, then shows "Try again"', async () => {
    const t = setup([err(503, 'unavailable'), new TypeError('net'), err(503, 'unavailable'), err(503, 'unavailable')]);
    await t.api.GET('/v1/me' as never);
    expect(t.sleep.mock.calls.map((c) => (c as unknown as [number])[0])).toEqual([1000, 2000, 4000]);
    expect(t.notify).toHaveBeenCalledWith('Try again');
  });
  it('rethrows a network failure of a write with the notice', async () => {
    const t = setup([new TypeError('net')]);
    await expect(t.api.PATCH('/v1/pages/{id}' as never, { params: { path: { id: 'p1' } }, body: {} } as never)).rejects.toThrow('net');
    expect(t.notify).toHaveBeenCalledWith('Try again');
  });
  it('has a text for every error code of the table and shows it as a notice', async () => {
    for (const code of [
      'would_create_cycle',
      'too_deep',
      'collection_full',
      'collection_deleted',
      'name_taken',
      'last_admin',
      'save_failed',
      'conflict',
      'too_large',
      'type_not_allowed',
      'type_mismatch',
      'upload_missing',
      'size_mismatch',
      'tenant_pages_full',
    ]) {
      expect(MESSAGES[code]).toBeTruthy();
      const t = setup([err(409, code)]);
      await t.api.PATCH('/v1/pages/{id}' as never, { params: { path: { id: 'p1' } }, body: {} } as never);
      expect(t.notify).toHaveBeenCalledWith(messageFor(code));
    }
  });
  it('says "You can\'t do that here" for a refused write and "Something went wrong" otherwise', async () => {
    const a = setup([err(403, 'forbidden')]);
    await a.api.PATCH('/v1/pages/{id}' as never, { params: { path: { id: 'p1' } }, body: {} } as never);
    expect(a.notify).toHaveBeenCalledWith("You can't do that here");
    const b = setup([err(500, 'internal')]);
    await b.api.GET('/v1/me' as never);
    expect(b.notify).toHaveBeenCalledWith('Something went wrong');
  });
  it('gives no notice for a 404 read, and none for 409 markdown_stale (a typed result)', async () => {
    const a = setup([err(404, 'not_found')]);
    const r = await a.api.GET('/v1/me' as never);
    expect(r.response.status).toBe(404);
    expect(a.notify).not.toHaveBeenCalled();
    const b = setup([err(409, 'markdown_stale')]);
    await b.api.PATCH('/v1/pages/{id}' as never, { params: { path: { id: 'p1' } }, body: {} } as never);
    expect(b.notify).not.toHaveBeenCalled();
  });
  it('reloads for a 426 client_too_old', async () => {
    const t = setup([err(426, 'client_too_old')]);
    await t.api.GET('/v1/me' as never);
    expect(t.reload).toHaveBeenCalled();
  });
});

describe('Retry-After', () => {
  const now = Date.parse('2026-11-23T22:00:00Z');
  it('reads whole seconds and HTTP dates, and nothing else', () => {
    expect(retryAfterSeconds('5', now)).toBe(5);
    expect(retryAfterSeconds(' 12 ', now)).toBe(12);
    expect(retryAfterSeconds('Mon, 23 Nov 2026 22:00:07 GMT', now)).toBe(7);
    expect(retryAfterSeconds('Mon, 23 Nov 2026 21:59:00 GMT', now)).toBe(0);
    for (const bad of [null, '', '  ', 'soon', '-3', '1.5']) expect([bad, retryAfterSeconds(bad, now)]).toEqual([bad, null]);
  });
  it('waits for an HTTP-date Retry-After on a 503 and on a 429', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(now);
      const a = setup([err(503, 'unavailable', { 'Retry-After': 'Mon, 23 Nov 2026 22:00:09 GMT' }), json(200)]);
      const ra = await a.api.GET('/v1/me' as never);
      expect(a.sleep).toHaveBeenCalledWith(9000);
      expect(a.calls).toHaveLength(2);
      expect(ra.response.status).toBe(200);
      const b = setup([err(429, 'rate_limited', { 'Retry-After': 'Mon, 23 Nov 2026 22:00:03 GMT' }), json(200)]);
      const rb = await b.api.GET('/v1/me' as never);
      expect(b.sleep).toHaveBeenCalledWith(3000);
      expect(b.calls).toHaveLength(2);
      expect(rb.response.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cancelled requests', () => {
  it('rethrows an aborted GET at once: one call, no sleep, no notice', async () => {
    const t = setup([new DOMException('aborted', 'AbortError')]);
    await expect(t.api.GET('/v1/me' as never)).rejects.toThrow('aborted');
    expect(t.calls).toHaveLength(1);
    expect(t.sleep).not.toHaveBeenCalled();
    expect(t.notify).not.toHaveBeenCalled();
  });
  it('stops on an abort signal that fired, whatever the error', async () => {
    const t = setup([new TypeError('Failed to fetch')]);
    const controller = new AbortController();
    controller.abort();
    await expect(t.api.GET('/v1/me' as never, { signal: controller.signal } as never)).rejects.toBeTruthy();
    expect(t.sleep).not.toHaveBeenCalled();
    expect(t.notify).not.toHaveBeenCalled();
  });
});
