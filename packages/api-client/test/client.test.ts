import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/index.js';

const config = { collabUrl: 'wss://docs.example.test/collab', minClientVersion: '1.0.0', local: true, providerProjectId: null, providerBaseUrl: null, fileStoreOrigin: null };

/** A server stand-in: records each request and answers with the given status and JSON, with no network. */
function setup(status = 200, body: unknown = config) {
  const seen: Request[] = [];
  const fetch = (request: Request): Promise<Response> => {
    seen.push(request);
    return Promise.resolve(Response.json(body, { status }));
  };
  return { fetch, seen };
}

describe('createApiClient', () => {
  it('gets the typed configuration sending the bearer token from getToken', async () => {
    const { fetch, seen } = setup();
    const client = createApiClient({ baseUrl: 'http://api.test', fetch, getToken: () => Promise.resolve('tok-1'), clientVersion: '1.2.3' });
    const { data, error, response } = await client.GET('/v1/config');
    expect(error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(data).toEqual(config);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer tok-1');
    expect(seen[0]?.headers.get('x-grimoire-client-version')).toBe('1.2.3');
  });

  it('sends no Authorization header when there is no token, and no version header when none is given', async () => {
    const { fetch, seen } = setup();
    const client = createApiClient({ baseUrl: 'http://api.test', fetch, getToken: () => null });
    expect((await client.GET('/v1/config')).response.status).toBe(200);
    expect(seen[0]?.headers.has('authorization')).toBe(false);
    expect(seen[0]?.headers.has('x-grimoire-client-version')).toBe(false);
  });

  it('returns the error envelope as `error` on a refusal', async () => {
    const { fetch } = setup(503, { error: { code: 'unavailable', message: 'The service is unavailable. Try again later.' } });
    const client = createApiClient({ baseUrl: 'http://api.test', fetch });
    const { data, error, response } = await client.GET('/v1/config');
    expect(data).toBeUndefined();
    expect(response.status).toBe(503);
    expect(error?.error.code).toBe('unavailable');
  });
});
