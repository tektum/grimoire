import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createSearchRepo } from '../../src/search.js';
import { createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// M7-T01 (R9.10, decision 14): the search over 10,000 generated pages of about 4 KB in one tenant, with 40 small tenants beside it, as a person who sees every collection and as one who sees
// one in a hundred. A two-word query that matches several hundred pages. The rows of the other tenants share the vocabulary, so the index holds all of them and a query still has to
// stay inside its tenant. The measurements are written to the log, and to the file named by GRIMOIRE_LATENCY_OUT when it is set (the proof document is made from that).
const BIG = 'T-big';
const COLLECTIONS = 100;
const PAGES = 10_000;
const SMALL_TENANTS = 40;
const SMALL_PAGES = 25;
const QUERY = 'w17 w42';
const RUNS = 7;

let t: TestDatabase;
let all: string[] = [];

async function seed(tenant: string, pages: number, collections: number, user: string): Promise<string[]> {
  const ids: string[] = [];
  for (let c = 0; c < collections; c += 1) {
    const rows = await t.admin.query<{ id: string }>(`insert into collections (name, position, created_by, tenant_id) values ($1, $2, $3, $4) returning id`, [`${tenant} c${String(c)}`, `p${String(c).padStart(5, '0')}`, user, tenant]);
    ids.push((rows[0] as { id: string }).id);
  }
  // Each page is 600 words drawn from a vocabulary of 2,000 (about 4 KB), by a hash of its number, so a two-word query matches a few percent of the pages.
  await t.admin.query(
    `insert into pages (collection_id, created_by, tenant_id, title, text_content, last_edited_at)
     select (select array_agg(id order by id) from collections where tenant_id = $1)[1 + (g % $2)], $3, $1, 'Page ' || g,
            (select string_agg('w' || (abs(hashtext($1 || g::text || i::text)) % 2000), ' ') from generate_series(1, 600) i), now() - (g % 1000) * interval '1 minute'
       from generate_series(1, $4) g`,
    [tenant, collections, user, pages],
  );
  return ids;
}

beforeAll(async () => {
  t = await createTestDatabase('latency');
  await t.admin.query(`insert into tenants (id, name) values ('${BIG}', 'Big')`);
  const user = (await t.admin.query<{ id: string }>(`insert into users (descope_user_id, email, name, role, tenant_id) values ('lat', 'lat@example.com', 'lat', 'member', '${BIG}') returning id`))[0]?.id as string;
  all = await seed(BIG, PAGES, COLLECTIONS, user);
  for (let i = 0; i < SMALL_TENANTS; i += 1) {
    const tenant = `T-small-${String(i)}`;
    await t.admin.query(`insert into tenants (id, name) values ('${tenant}', 'Small ${String(i)}')`);
    const owner = (await t.admin.query<{ id: string }>(`insert into users (descope_user_id, email, name, role, tenant_id) values ($1, $2, 'u', 'member', $3) returning id`, [`s${String(i)}`, `s${String(i)}@example.com`, tenant]))[0]?.id as string;
    await seed(tenant, SMALL_PAGES, 2, owner);
  }
  await t.admin.query('analyze pages');
}, 600_000);
afterAll(async () => { await t?.drop(); });

async function measure(label: string, collectionIds: readonly string[], tenantId = BIG): Promise<{ median: number; max: number; hits: number }> {
  const repo = createSearchRepo(t.app, { statementTimeoutMs: 10_000 });
  const request = { tenantId, collectionIds, query: QUERY, limit: 20 };
  await repo.search(request); // warm: plan, caches
  const times: number[] = [];
  let hits = 0;
  for (let i = 0; i < RUNS; i += 1) {
    const start = performance.now();
    hits = (await repo.search(request)).hits.length;
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const result = { median: Math.round(times[Math.floor(RUNS / 2)] as number), max: Math.round(times[RUNS - 1] as number), hits };
  const line = JSON.stringify({ label, pages: PAGES, tenants: SMALL_TENANTS + 1, ...result });
  console.log(`latency ${line}`);
  if (process.env['GRIMOIRE_LATENCY_OUT']) appendFileSync(process.env['GRIMOIRE_LATENCY_OUT'], `${line}\n`);
  return result;
}

describe('search latency over 10,000 pages (R9.10)', () => {
  it('a person who sees every collection gets the first page within 1,000 ms', async () => {
    const r = await measure('sees-100-percent', all);
    expect(r.hits).toBe(20);
    expect(r.median, `median of ${String(RUNS)}: ${String(r.median)} ms, worst ${String(r.max)} ms`).toBeLessThan(1000);
  }, 300_000);

  it('a person who sees one collection in a hundred gets it within 100 ms', async () => {
    const r = await measure('sees-1-percent', [all[7] as string]);
    expect(r.median, `median of ${String(RUNS)}: ${String(r.median)} ms, worst ${String(r.max)} ms`).toBeLessThan(100);
  }, 300_000);

  it('stays inside the tenant: a small tenant is answered from its own twenty-five pages only, and is not slowed by the big one', async () => {
    const small = (await t.admin.query<{ id: string }>(`select id from collections where tenant_id = 'T-small-3'`)).map((r) => r.id);
    const r = await measure('small-tenant', small, 'T-small-3');
    expect(r.hits).toBeLessThanOrEqual(SMALL_PAGES);
    expect(r.median).toBeLessThan(100);
    const repo = createSearchRepo(t.app, { statementTimeoutMs: 10_000 });
    const crossing = await repo.search({ tenantId: 'T-small-3', collectionIds: all, query: QUERY, limit: 50 }); // the big tenant's collections, asked for as the small one
    expect(crossing.hits).toEqual([]);
  }, 300_000);
});
