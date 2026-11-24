import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiLike } from '../../src/api/query';
import { ConnectionManager } from '../../src/editor/core/connection';
import { isClientOutdated, resetClientOutdated } from '../../src/gate/outdated';
import { recheckMinClientVersion } from '../../src/gate/recheck';
import { flush, harness } from './support';

afterEach(() => resetClientOutdated());

const api = (answer: () => Promise<{ data?: unknown; response: { status: number; ok: boolean } }>): ApiLike => ({ GET: vi.fn(answer) }) as unknown as ApiLike;
const config = (min: string) => api(async () => ({ data: { minClientVersion: min }, response: { status: 200, ok: true } }));

describe('the minimum client version, checked again', () => {
  it('marks the client outdated when the server now asks for a newer one, and asks GET /v1/config', async () => {
    const client = config('99.0.0');
    await recheckMinClientVersion(client, '1.2.3');
    expect(isClientOutdated()).toBe(true);
    expect(client.GET).toHaveBeenCalledWith('/v1/config', {});
  });

  it('leaves the client alone when its version is enough (equal or newer)', async () => {
    await recheckMinClientVersion(config('1.2.3'), '1.2.3');
    await recheckMinClientVersion(config('1.0.0'), '1.2.3');
    expect(isClientOutdated()).toBe(false);
  });

  it('a 426 is the same as too old', async () => {
    await recheckMinClientVersion(
      api(async () => ({ response: { status: 426, ok: false } })),
      '1.2.3',
    );
    expect(isClientOutdated()).toBe(true);
  });

  it('changes nothing when the server cannot be asked or answers something else', async () => {
    await recheckMinClientVersion(
      api(async () => Promise.reject(new Error('offline'))),
      '1.2.3',
    );
    await recheckMinClientVersion(
      api(async () => ({ response: { status: 503, ok: false } })),
      '1.2.3',
    );
    await recheckMinClientVersion(
      api(async () => ({ data: { minClientVersion: 5 }, response: { status: 200, ok: true } })),
      '1.2.3',
    );
    await recheckMinClientVersion(
      api(async () => ({ data: undefined, response: { status: 200, ok: true } })),
      '1.2.3',
    );
    expect(isClientOutdated()).toBe(false);
  });

  it('uses the version of this client when none is given', async () => {
    await recheckMinClientVersion(config('0.0.0'));
    expect(isClientOutdated()).toBe(false);
    await recheckMinClientVersion(config('999.0.0'));
    expect(isClientOutdated()).toBe(true);
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
