import { describe, expect, it, vi } from 'vitest';
import { UNKNOWN_NAME, createDirectory, sessionDirectory } from '../../src/editor/core/directory';
import type { ApiLike } from '../../src/api/query';
import { FakeClock } from './support';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const make = (fetchNames: (ids: string[]) => Promise<{ id: string; name: string }[]>) => {
  const clock = new FakeClock();
  const directory = createDirectory({ fetchNames, setTimeout: (fn, ms) => clock.after(fn, ms), now: () => clock.now() });
  return { clock, directory };
};

describe('the presence directory', () => {
  it('shows "Someone" until a name arrives, then the name, and tells the listeners', async () => {
    const { clock, directory } = make(async (ids) => ids.map((i) => ({ id: i, name: 'Ada' })));
    const heard = vi.fn();
    directory.subscribe(heard);
    directory.request([id(1)]);
    expect(directory.nameOf(id(1))).toBe(UNKNOWN_NAME);
    await clock.advance(30);
    expect(directory.nameOf(id(1))).toBe('Ada');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('asks for the ids that arrive close together in one request, and for more than 50 in batches of 50', async () => {
    const calls: string[][] = [];
    const { clock, directory } = make(async (ids) => (calls.push(ids), ids.map((i) => ({ id: i, name: 'n' }))));
    directory.request([id(1), id(2)]);
    directory.request([id(3)]);
    await clock.advance(30);
    expect(calls).toEqual([[id(1), id(2), id(3)]]);
    calls.length = 0;
    directory.request(Array.from({ length: 120 }, (_, i) => id(100 + i)));
    await clock.advance(30);
    expect(calls.map((c) => c.length)).toEqual([50, 50, 20]);
  });

  it('keeps a name for the session: an id is not asked for twice, even when it was unknown to the directory', async () => {
    const calls: string[][] = [];
    const { clock, directory } = make(async (ids) => (calls.push(ids), []));
    directory.request([id(1)]);
    await clock.advance(30);
    expect(directory.nameOf(id(1))).toBe(UNKNOWN_NAME);
    directory.request([id(1)]);
    await clock.advance(1000);
    expect(calls).toHaveLength(1);
  });

  it('does not ask twice for an id that is already asked for and waiting', async () => {
    let release: () => void = () => undefined;
    const calls: string[][] = [];
    const { clock, directory } = make((ids) => (calls.push(ids), new Promise((resolve) => void (release = () => resolve(ids.map((i) => ({ id: i, name: 'n' })))))));
    directory.request([id(1)]);
    await clock.advance(30);
    directory.request([id(1), id(1)]);
    await clock.advance(1000);
    expect(calls).toHaveLength(1);
    release();
  });

  it('does not ask for what is not an id: it shows "Someone" with no request', async () => {
    const calls: string[][] = [];
    const { clock, directory } = make(async (ids) => (calls.push(ids), []));
    directory.request(['not-an-id', '<img src=x onerror=alert(1)>']);
    await clock.advance(100);
    expect(calls).toEqual([]);
    expect(directory.nameOf('not-an-id')).toBe(UNKNOWN_NAME);
  });

  it('after a failed request shows "Someone", and asks again, but not before a pause (the lookup has a rate limit)', async () => {
    let fail = true;
    const calls: string[][] = [];
    const { clock, directory } = make(async (ids) => {
      calls.push(ids);
      if (fail) throw new Error('503');
      return ids.map((i) => ({ id: i, name: 'Ada' }));
    });
    directory.request([id(1)]);
    await clock.advance(30);
    expect(directory.nameOf(id(1))).toBe(UNKNOWN_NAME);
    directory.request([id(1)]);
    await clock.advance(1000);
    expect(calls).toHaveLength(1); // too soon
    await clock.advance(5000);
    fail = false;
    directory.request([id(1)]);
    await clock.advance(30);
    expect(directory.nameOf(id(1))).toBe('Ada');
  });

  it('stops telling a listener that unsubscribed', async () => {
    const { clock, directory } = make(async (ids) => ids.map((i) => ({ id: i, name: 'n' })));
    const heard = vi.fn();
    directory.subscribe(heard)();
    directory.request([id(1)]);
    await clock.advance(30);
    expect(heard).not.toHaveBeenCalled();
  });

  it('matches names to ids without regard to the case of the id', async () => {
    const { clock, directory } = make(async () => [{ id: id(1).toUpperCase(), name: 'Ada' }]);
    directory.request([id(1)]);
    await clock.advance(30);
    expect(directory.nameOf(id(1))).toBe('Ada');
  });
});

describe('the directory of a session', () => {
  const api = (post: ReturnType<typeof vi.fn>) => ({ POST: post }) as unknown as ApiLike;

  it('is one directory per API client, and asks POST /v1/users/names with the ids in the body', async () => {
    vi.useFakeTimers();
    try {
      const post = vi.fn(async () => ({ data: { items: [{ id: id(1), name: 'Ada' }] }, response: new Response('', { status: 200 }) }));
      const client = api(post);
      expect(sessionDirectory(client)).toBe(sessionDirectory(client));
      expect(sessionDirectory(api(vi.fn()))).not.toBe(sessionDirectory(client));
      const directory = sessionDirectory(client);
      directory.request([id(1)]);
      await vi.advanceTimersByTimeAsync(30);
      expect(post).toHaveBeenCalledWith('/v1/users/names', { body: { ids: [id(1)] } });
      expect(directory.nameOf(id(1))).toBe('Ada');
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an answer that is not ok as a failed request', async () => {
    vi.useFakeTimers();
    try {
      const post = vi.fn(async () => ({ data: undefined, response: new Response('', { status: 429 }) }));
      const directory = sessionDirectory(api(post));
      directory.request([id(2)]);
      await vi.advanceTimersByTimeAsync(30);
      expect(directory.nameOf(id(2))).toBe(UNKNOWN_NAME);
      expect(post).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
