import { describe, expect, it } from 'vitest';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import type { Config } from '@tektum/grimoire-core/ports/config';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

type Overrides = Parameters<typeof makeFakeConfig>[0];

function build(overrides: Overrides = {}) {
  const t = makeContext();
  const config: Config = makeFakeConfig(overrides);
  const app = createApp({ ...t.ctx, config, http: { ...t.ctx.http, config } });
  return { app, t };
}

describe('GET /v1/config', () => {
  it('answers without a token, and with a token the server would refuse elsewhere', async () => {
    const { app } = build({ publicCollabUrl: 'wss://docs.example.test/collab', minClientVersion: '1.4.2' });
    const anonymous = await app.request('/v1/config');
    const withToken = await app.request('/v1/config', { headers: { Authorization: 'Bearer not-a-real-token' } });
    expect(anonymous.status).toBe(200);
    expect(withToken.status).toBe(200);
    expect(await anonymous.json()).toEqual({
      collabUrl: 'wss://docs.example.test/collab',
      minClientVersion: '1.4.2',
      local: true,
      providerProjectId: null,
      fileStoreOrigin: null,
    });
  });

  it('returns the sign-in provider project id and the public origin of the file store', async () => {
    const base = makeFakeConfig();
    const files = { ...(base.files ?? {}), publicOrigin: 'https://files.example.test' } as NonNullable<Config['files']>;
    const { app } = build({ publicCollabUrl: 'wss://docs.example.test/collab', descopeProjectId: 'P2abc', files });
    const body = (await (await app.request('/v1/config')).json()) as Record<string, unknown>;
    expect(body['providerProjectId']).toBe('P2abc');
    expect(body['fileStoreOrigin']).toBe('https://files.example.test');
  });

  it('reports local true only in local mode', async () => {
    const local = build({ local: true, publicCollabUrl: 'wss://c.example.test/collab' });
    const hosted = build({ local: false, publicCollabUrl: 'wss://c.example.test/collab' });
    expect(((await (await local.app.request('/v1/config')).json()) as { local: boolean }).local).toBe(true);
    expect(((await (await hosted.app.request('/v1/config')).json()) as { local: boolean }).local).toBe(false);
  });

  it('derives the collaboration address from the listen address in local mode only', async () => {
    const { app } = build({ local: true, host: '127.0.0.1', port: 8123 });
    expect(((await (await app.request('/v1/config')).json()) as { collabUrl: string }).collabUrl).toBe('ws://127.0.0.1:8123/collab');
  });

  it('points the local collaboration address at the collaboration port when it is separate', async () => {
    const { app } = build({ local: true, host: '127.0.0.1', port: 8123, collabPort: 8124 });
    expect(((await (await app.request('/v1/config')).json()) as { collabUrl: string }).collabUrl).toBe('ws://127.0.0.1:8124/collab');
  });

  it('answers 503 unavailable with one log line outside local mode when the collaboration address is not set', async () => {
    const { app, t } = build({ local: false });
    const res = await app.request('/v1/config');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unavailable');
    expect(t.logger.entries.filter((e) => e.event === 'config.collab_url_missing')).toHaveLength(1);
  });
});
