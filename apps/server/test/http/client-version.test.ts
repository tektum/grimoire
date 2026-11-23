import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

const HEADER = 'X-Grimoire-Client-Version';

function build() {
  const t = makeContext();
  const app = createApp({ ...t.ctx, config: { ...t.ctx.config, minClientVersion: '1.2.0' } });
  app.get('/v1/me', (c) => c.json({ ok: true }));
  app.get('/v1/config', (c) => c.json({ ok: true }));
  return { app, t };
}

const get = (app: ReturnType<typeof build>['app'], path: string, version?: string) =>
  app.request(path, { headers: version === undefined ? {} : { [HEADER]: version, authorization: 'Bearer x' } });

describe('client version gate', () => {
  it('refuses a version below the minimum in the envelope, before any token work', async () => {
    const { app, t } = build();
    const res = await get(app, '/v1/me', '1.1.9');
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({ error: { code: 'client_too_old', message: 'This client is too old. Update it to continue.' } });
    expect(t.logger.entries.some((e) => JSON.stringify(e).includes('http.auth_rejected'))).toBe(false);
  });

  it.each(['1.2.0', '2.0.0', '1.10.0'])('lets %s through', async (version) => {
    const { app } = build();
    expect((await get(app, '/v1/me', version)).status).toBe(200);
  });

  it('lets a missing or malformed header through', async () => {
    const { app } = build();
    expect((await get(app, '/v1/me')).status).toBe(200);
    expect((await get(app, '/v1/me', 'abc')).status).toBe(200);
    expect((await get(app, '/v1/me', '1.1')).status).toBe(200);
  });

  it('never refuses the config and health routes', async () => {
    const { app } = build();
    for (const path of ['/v1/config', '/healthz', '/readyz']) expect((await get(app, path, '0.0.1')).status).toBe(200);
  });

  it('lists the header in the preflight', async () => {
    const { app } = build();
    const res = await app.request('/v1/me', {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:8080', 'access-control-request-method': 'GET', 'access-control-request-headers': HEADER },
    });
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(HEADER.toLowerCase());
  });
});
