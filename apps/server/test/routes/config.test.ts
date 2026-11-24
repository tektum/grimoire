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
      providerBaseUrl: null,
      fileStoreOrigin: null,
      maxAttachmentBytes: null,
      pendingUploadsMax: null,
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

  it('tells the client the largest upload and how many uploads a person may leave waiting, from the file settings, and null when there is no store', async () => {
    const base = makeFakeConfig();
    const files = { ...(base.files ?? {}), publicOrigin: 'https://files.example.test', maxBytes: 26_214_400, pendingMaxPerUser: 10 } as NonNullable<Config['files']>;
    const withStore = build({ publicCollabUrl: 'wss://docs.example.test/collab', files });
    const body = (await (await withStore.app.request('/v1/config')).json()) as Record<string, unknown>;
    expect(body['maxAttachmentBytes']).toBe(26_214_400);
    expect(body['pendingUploadsMax']).toBe(10);
    const without = build({ publicCollabUrl: 'wss://docs.example.test/collab' });
    const none = (await (await without.app.request('/v1/config')).json()) as Record<string, unknown>;
    expect(none['maxAttachmentBytes']).toBeNull();
    expect(none['pendingUploadsMax']).toBeNull();
  });

  it('returns the sign-in provider endpoint the server was composed with, and null when there is none', async () => {
    const t = makeContext();
    const config: Config = makeFakeConfig({ publicCollabUrl: 'wss://docs.example.test/collab', descopeProjectId: 'P2abc' });
    const withUrl = createApp({ ...t.ctx, config, http: { ...t.ctx.http, config, providerBaseUrl: 'https://api.eu1.example.test' } });
    expect(((await (await withUrl.request('/v1/config')).json()) as Record<string, unknown>)['providerBaseUrl']).toBe('https://api.eu1.example.test');
    const without = createApp({ ...t.ctx, config, http: { ...t.ctx.http, config } });
    expect(((await (await without.request('/v1/config')).json()) as Record<string, unknown>)['providerBaseUrl']).toBeNull();
    const none = createApp({ ...t.ctx, config, http: { ...t.ctx.http, config, providerBaseUrl: null } });
    expect(((await (await none.request('/v1/config')).json()) as Record<string, unknown>)['providerBaseUrl']).toBeNull();
  });

  it('does not take the raw setting: the route answers from what the server computed', async () => {
    const t = makeContext();
    const config: Config = makeFakeConfig({ publicCollabUrl: 'wss://docs.example.test/collab', descopeProjectId: 'P2abc', descopeBaseUrl: 'https://raw.example.test/' });
    const app = createApp({ ...t.ctx, config, http: { ...t.ctx.http, config, providerBaseUrl: 'https://computed.example.test' } });
    expect(((await (await app.request('/v1/config')).json()) as Record<string, unknown>)['providerBaseUrl']).toBe('https://computed.example.test');
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

  it.each([
    ['0.0.0.0', 'ws://127.0.0.1:8123/collab'],
    ['::', 'ws://127.0.0.1:8123/collab'],
    ['::1', 'ws://[::1]:8123/collab'],
  ])('builds a dialable local collaboration address from the bind host %s', async (host, expected) => {
    const { app } = build({ local: true, host, port: 8123 });
    expect(((await (await app.request('/v1/config')).json()) as { collabUrl: string }).collabUrl).toBe(expected);
  });

  it('answers 503 unavailable with one log line outside local mode when the collaboration address is not set', async () => {
    const { app, t } = build({ local: false });
    const res = await app.request('/v1/config');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unavailable');
    expect(t.logger.entries.filter((e) => e.event === 'config.collab_url_missing')).toHaveLength(1);
  });
});
