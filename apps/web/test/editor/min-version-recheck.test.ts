import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../../src/editor/core/connection';
import { isClientOutdated, markClientOutdated, resetClientOutdated } from '../../src/gate/outdated';
import { recheckMinClientVersion } from '../../src/gate/recheck';
import { flush, harness } from './support';

afterEach(() => resetClientOutdated());

type Answer = { status: number; body?: unknown } | Error;
const fetching = (answer: Answer) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), { status: answer.status });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
};
const config = (min: unknown) => fetching({ status: 200, body: { minClientVersion: min } });

describe('the minimum client version, checked again', () => {
  it('marks the client outdated when the server now asks for a newer one, with a plain request: the config, no cookie, the version of this client', async () => {
    const { fetch, calls } = config('99.0.0');
    await recheckMinClientVersion({ apiUrl: 'http://api.test', fetch, clientVersion: '1.2.3' });
    expect(isClientOutdated()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://api.test/v1/config');
    expect(calls[0]!.init).toMatchObject({ credentials: 'omit', headers: { 'X-Grimoire-Client-Version': '1.2.3' } });
  });

  it('leaves the client alone when its version is enough (equal or newer)', async () => {
    await recheckMinClientVersion({ apiUrl: 'http://api.test', fetch: config('1.2.3').fetch, clientVersion: '1.2.3' });
    await recheckMinClientVersion({ apiUrl: 'http://api.test', fetch: config('1.0.0').fetch, clientVersion: '1.2.3' });
    expect(isClientOutdated()).toBe(false);
  });

  it('a 426 is the same as too old', async () => {
    await recheckMinClientVersion({ apiUrl: 'http://api.test', fetch: fetching({ status: 426 }).fetch, clientVersion: '1.2.3' });
    expect(isClientOutdated()).toBe(true);
  });

  it('changes nothing, and says nothing, when the server cannot be asked or answers something else', async () => {
    for (const answer of [new Error('offline'), { status: 503 }, { status: 429 }, { status: 200, body: { minClientVersion: 5 } }, { status: 200, body: null }] as Answer[]) {
      await recheckMinClientVersion({ apiUrl: 'http://api.test', fetch: fetching(answer).fetch, clientVersion: '1.2.3' });
    }
    expect(isClientOutdated()).toBe(false);
  });

  it('asks nothing once the client is known to be outdated', async () => {
    markClientOutdated();
    const { fetch, calls } = config('99.0.0');
    await recheckMinClientVersion({ apiUrl: 'http://api.test', fetch });
    expect(calls).toHaveLength(0);
  });

  it('uses the version of this client and the platform fetch when none are given', async () => {
    vi.stubGlobal('fetch', config('0.0.0').fetch);
    await recheckMinClientVersion({ apiUrl: 'http://api.test' });
    expect(isClientOutdated()).toBe(false);
    vi.stubGlobal('fetch', config('999.0.0').fetch);
    await recheckMinClientVersion({ apiUrl: 'http://api.test' });
    expect(isClientOutdated()).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('the connection manager asks for the check', () => {
  const make = () => {
    const h = harness();
    const onLongOffline = vi.fn();
    const manager = new ConnectionManager({ ...h.options, onLongOffline });
    manager.start();
    return { h, manager, onLongOffline };
  };

  it('when a connection is made again after more than a minute without one', async () => {
    const { h, onLongOffline } = make();
    await flush();
    h.last().provider.succeed(1);
    h.last().provider.disconnected();
    h.last().provider.close(1001);
    await h.clock.advance(61_000);
    h.last().provider.succeed(1);
    expect(onLongOffline).toHaveBeenCalledTimes(1);
  });

  it('not for the first connection, and not after a minute or less', async () => {
    const { h, onLongOffline } = make();
    await flush();
    h.last().provider.succeed(1);
    expect(onLongOffline).not.toHaveBeenCalled();
    h.last().provider.disconnected();
    await h.clock.advance(60_000);
    h.last().provider.succeed(1);
    expect(onLongOffline).not.toHaveBeenCalled();
  });

  it('once for one outage, not at every later sync', async () => {
    const { h, onLongOffline } = make();
    await flush();
    h.last().provider.succeed(1);
    h.last().provider.disconnected();
    await h.clock.advance(120_000);
    h.last().provider.succeed(1);
    h.last().provider.succeed(1);
    expect(onLongOffline).toHaveBeenCalledTimes(1);
  });

  it('counts an outage that only the close told of (no status event)', async () => {
    const { h, onLongOffline } = make();
    await flush();
    h.last().provider.succeed(1);
    h.last().provider.close(1001);
    await h.clock.advance(61_000);
    h.last().provider.succeed(1);
    expect(onLongOffline).toHaveBeenCalledTimes(1);
  });
});
