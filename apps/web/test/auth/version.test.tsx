import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebApi } from '../../src/api/client';
import { Gate } from '../../src/gate/Gate';
import { GATE_MESSAGES } from '../../src/gate/messages';
import { blockWhenOutdated, isClientOutdated, markClientOutdated, resetClientOutdated } from '../../src/gate/outdated';
import { isClientTooOld } from '../../src/gate/version';
import { CLIENT_VERSION } from '../../src/version';
import { config } from './support';

afterEach(() => {
  cleanup();
  resetClientOutdated();
});

const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function api(replies: Response[]) {
  const calls: Request[] = [];
  const queue = [...replies];
  const client = createWebApi({
    baseUrl: 'https://api.test',
    getToken: async () => 't',
    refresh: async () => true,
    signOut: vi.fn(),
    notify: vi.fn(),
    reload: markClientOutdated,
    sleep: async () => {},
    fetch: blockWhenOutdated(async (r) => {
      calls.push(r);
      return queue.shift() ?? json(200);
    }),
  });
  return { client, calls };
}

describe('the client version on the API path', () => {
  it('is sent on every request of the wrapper, equal to CLIENT_VERSION', async () => {
    const { client, calls } = api([]);
    await client.GET('/v1/me' as never);
    await client.POST('/v1/pages' as never, { body: {} } as never);
    await client.PATCH('/v1/pages/{id}' as never, { params: { path: { id: 'p1' } }, body: {} } as never);
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.headers.get('X-Grimoire-Client-Version')).toBe(CLIENT_VERSION);
  });

  it('a 426 client_too_old answer renders only the reload text and no further call leaves the client', async () => {
    const { client, calls } = api([json(426, { error: { code: 'client_too_old' } })]);
    render(<Gate options={{ apiUrl: 'https://api.test', fetch: (async () => json(200, config())) as never }}>{() => <p>the app</p>}</Gate>);
    expect(await screen.findByText('the app')).toBeTruthy();
    await client.GET('/v1/me' as never);
    expect(isClientOutdated()).toBe(true);
    expect(await screen.findByText(GATE_MESSAGES.outdated)).toBeTruthy();
    expect(document.body.textContent).toBe(GATE_MESSAGES.outdated);
    const before = calls.length;
    await expect(client.GET('/v1/me' as never)).rejects.toThrow('too old');
    await expect(client.POST('/v1/pages' as never, { body: {} } as never)).rejects.toThrow('too old');
    expect(calls).toHaveLength(before);
  });

  it('uses compareVersions of packages/core, imported from its version module (by grep)', () => {
    const source = readFileSync(path.resolve(import.meta.dirname, '../../src/gate/version.ts'), 'utf8');
    expect(source).toMatch(/import \{[^}]*\bcompareVersions\b[^}]*\} from '@tektum\/grimoire-core\/version'/);
    expect(source).not.toMatch(/split\('\.'\)|localeCompare/); // no second comparison written by hand
  });

  it('compares as numbers, not as text: 1.10.0 is newer than 1.9.0', () => {
    expect(isClientTooOld('1.10.0', '1.9.0')).toBe(true);
    expect(isClientTooOld('1.9.0', '1.10.0')).toBe(false);
    expect(isClientTooOld('0.0.0', '0.0.0')).toBe(false);
    expect(isClientTooOld('not-a-version', '1.0.0')).toBe(false); // the server's own setting is validated there
    expect(isClientTooOld('1.0.0', 'dev')).toBe(true); // a client that cannot read its own version is not current
  });
});
