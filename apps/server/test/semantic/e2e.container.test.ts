import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin, startServer } from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';

// M7-T07, the semantic end to end, on the real thing: the built server (`dist/main.js`, started as a process with the settings a deployment gives it), its real PostgreSQL database, the real model
// files, the real embedding jobs, the real search route, and people who sign in with development tokens. Two pages are made through the API, one about holidays and one about planning; the embedding
// sweep (its debounce and its period shortened by setting) embeds both; a search for "time off", which has no word in common with either page, finds the holiday page first, by its meaning; a person
// who may not read the holiday page gets neither the page nor a changed answer; and with `GRIMOIRE_SEMANTIC_SEARCH=off` the same server answers `semantic: false` and still finds a page by its words.
// Run it with the real files (`node scripts/fetch-models.mjs`, or GRIMOIRE_MODEL_DIR), a built tree (`bun run build`) and PostgreSQL (`make db-up`).
const modelDir = process.env['GRIMOIRE_MODEL_DIR'] ?? '/app/models';
const DB = 'grimoire_m7t07_semantic_e2e';
const SECRET = randomBytes(24).toString('hex'); // made up for this run and given to both servers: they accept the tokens that carry it
const token = (name: string, role: 'admin' | 'member'): string => `dev:${SECRET}:${name}:${role}`;
const ADA = token('ada', 'admin');
const ALICE = token('alice', 'member'); // may read the holiday page's collection
const BOB = token('bob', 'member'); // may not

const HOLIDAYS = '# Vacation days\n\nEvery employee receives twenty five days of paid holiday each year. Ask your manager for the days at least two weeks ahead, and the days you did not use carry over until March.';
const PLANNING = '# Quarterly planning\n\nThe quarterly planning meeting sets the budget, the hiring targets and the product roadmap for the next three months. Each team lead presents the goals and the risks.';

interface Item { readonly pageId: string; readonly title: string; readonly matchedPassage?: { readonly text: string } }
interface Answer { readonly items: readonly Item[]; readonly semantic: boolean }

let on: ServerProcess | undefined;
let off: ServerProcess | undefined;

const start = (semantic: 'on' | 'off'): Promise<ServerProcess> => startServer({
  env: {
    GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_DEV_TOKEN_SECRET: SECRET, GRIMOIRE_SEMANTIC_SEARCH: semantic, GRIMOIRE_SEMANTIC_MODEL_DIR: modelDir,
    GRIMOIRE_SEMANTIC_DEBOUNCE_SECONDS: '3', GRIMOIRE_SEMANTIC_SWEEP_SECONDS: '5', // the shortest the settings allow
  },
});

async function call<T>(server: ServerProcess, method: 'GET' | 'POST' | 'PUT', path: string, who: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server.url}${path}`, {
    method, headers: { authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: (await response.json()) as T };
}
const created = async (server: ServerProcess, path: string, who: string, body: unknown): Promise<{ id: string }> => {
  const r = await call<{ id: string }>(server, 'POST', path, who, body);
  expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(201);
  return r.body;
};
const search = async (server: ServerProcess, who: string, q: string): Promise<Answer> => {
  const r = await call<Answer>(server, 'GET', `/v1/search?q=${encodeURIComponent(q)}`, who);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
/** The pages whose state is `ready` in the database: the embedding sweep has been through them. */
const embedded = async (): Promise<number> => Number((await sqlAdmin<{ n: number }>(DB, `select count(*)::int as n from page_embedding_state where status = 'ready'`))[0]?.n);

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
}, 120_000);
afterAll(async () => {
  await on?.kill();
  await off?.kill();
  await dropTestDatabase(DB);
});

describe('the semantic search, on the real server and the real model', () => {
  it('embeds the pages the sweep finds, finds the holiday page first for "time off" by meaning, shows a person who may not read it nothing of it, and answers without meaning when it is off', { timeout: 600_000 }, async () => {
    const server = await start('on');
    on = server;
    for (const who of [ADA, ALICE, BOB]) expect((await call(server, 'GET', '/v1/me', who)).status).toBe(200); // a first sign-in makes the person
    const alice = (await call<{ id: string }>(server, 'GET', '/v1/me', ALICE)).body.id;
    const team = await created(server, '/v1/collections', ADA, { name: 'Team', defaultPermission: 'read' }); // everyone reads it
    const hr = await created(server, '/v1/collections', ADA, { name: 'Human resources' }); // nobody does but who is given it
    expect((await call(server, 'PUT', `/v1/collections/${hr.id}/access`, ADA, { principalType: 'user', principalId: alice, permission: 'read' })).status).toBe(200);

    // The planning page first, embedded, so that what Bob sees before the holiday page exists is known.
    const planning = await created(server, '/v1/pages', ADA, { collectionId: team.id, title: 'Quarterly planning', markdown: PLANNING });
    await vi.waitFor(async () => { expect(await embedded()).toBe(1); }, { timeout: 90_000, interval: 1000 });
    const before = await search(server, BOB, 'time off');

    const holidays = await created(server, '/v1/pages', ADA, { collectionId: hr.id, title: 'Vacation days', markdown: HOLIDAYS });
    await vi.waitFor(async () => { expect(await embedded()).toBe(2); }, { timeout: 90_000, interval: 1000 }); // both pages, within 90 s of the second one's creation

    const found = await search(server, ALICE, 'time off');
    expect(found.semantic, JSON.stringify(found)).toBe(true);
    expect(found.items[0]?.pageId, JSON.stringify(found)).toBe(holidays.id); // by its meaning: "time off" is a word of neither page
    expect(found.items[0]?.matchedPassage?.text).toContain('holiday');

    const hidden = await search(server, BOB, 'time off');
    expect(JSON.stringify(hidden)).not.toContain(holidays.id);
    expect(JSON.stringify(hidden)).not.toContain('Vacation');
    expect(JSON.stringify(hidden)).not.toContain('holiday');
    expect(hidden).toEqual(before); // and the same answer as before the page existed: its count, its order, its ranks
    expect(JSON.stringify(await search(server, BOB, 'vacation'))).not.toContain(holidays.id); // and not by its words either

    await server.kill();
    on = undefined;
    const plain = await start('off');
    off = plain;
    const byWords = await search(plain, ALICE, 'vacation');
    expect(byWords.semantic).toBe(false);
    expect(byWords.items.map((i) => i.pageId)).toEqual([holidays.id]); // a page that matches by its words is still found
    const byMeaning = await search(plain, ALICE, 'time off');
    expect(byMeaning).toEqual({ items: [], semantic: false, nextCursor: null }); // and with no meaning, "time off" matches nothing: the answer of the first server came from the model
    expect(planning.id).not.toBe(holidays.id);
  });
});
