// @vitest-environment node
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { createServer } from '../../scripts/serve.mjs';

/** The page is served from one origin (serve.mjs), the API answers from another: the browser's cross-origin rules apply to the fetch. */
let dist: string;
let web: http.Server;
let api: http.Server;
let webOrigin: string;
let apiOrigin: string;
let allowOrigin: string | null = null;

const listen = (server: http.Server) => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

beforeAll(async () => {
  dist = mkdtempSync(path.join(tmpdir(), 'grimoire-dist-'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app</title>');
  web = createServer({ dist });
  api = http.createServer((req, res) => {
    if (allowOrigin !== null) res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ collabUrl: 'ws://x', minClientVersion: '0.0.0', local: false }));
  });
  webOrigin = await listen(web);
  apiOrigin = await listen(api);
});
afterAll(() => {
  web.close();
  api.close();
  rmSync(dist, { recursive: true, force: true });
});

/** Runs `fetch` as the page at `webOrigin` would (the window's origin is the page's). */
async function getConfig(): Promise<{ ok: boolean; body?: unknown; error?: string }> {
  const window = new Window({ url: `${webOrigin}/p/some-page-ab12cd` });
  try {
    const response = await window.fetch(`${apiOrigin}/v1/config`, { credentials: 'omit' });
    return { ok: response.ok, body: await response.json() };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    await window.happyDOM.close();
  }
}

describe('the client served from one origin, the API on another', () => {
  it('serves index.html for a deep link, with the headers of the header file', async () => {
    const response = await fetch(`${webOrigin}/p/some-page-ab12cd/history`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>app</title>');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('reads GET /v1/config when the API allows the page origin', async () => {
    allowOrigin = webOrigin;
    expect(await getConfig()).toEqual({ ok: true, body: { collabUrl: 'ws://x', minClientVersion: '0.0.0', local: false } });
  });
  it('cannot read it when the API sends no CORS header', async () => {
    allowOrigin = null;
    const result = await getConfig();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
  it('cannot read it when the API allows another origin only', async () => {
    allowOrigin = 'http://other.example';
    expect((await getConfig()).ok).toBe(false);
  });
});
