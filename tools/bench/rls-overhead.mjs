// BENCHMARK, not a test and not part of the product. Run by .github/workflows/bench-rls.yml (workflow_dispatch only) against a Postgres started with the staging
// parameters (tools/bench/compose.bench.yaml). It measures what `scoped()` and the row-level security policies of docs/tenancy.md step 4 cost per request:
//   plain   the runtime pool, the same SQL, no tenant setting
//   scoped  scoped(db, tenant): `begin; set local app.tenant` in one round trip, row-level security switched off
//   policy  scoped() with the policies of migration 0014 in force (switched back on: tenant_isolation, operator_all and tenants_self, as the product ships them)
// for three requests: page-open (pages.get: the page, then its breadcrumb), tree-read (collections.tree) and chunk-search (the semantic statement of embeddings.search over 140k chunks of 768 dimensions with STORAGE MAIN). Data: 100 collections, about 10k pages of about 4 KB in 41 tenants (40 small, one big).
// Needs `bun run build` first (it uses the built adapter and the CLI to migrate). Env: BENCH_HOST (default 127.0.0.1:55432), BENCH_REQUESTS (5000), BENCH_CLIENTS (20).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { createDatabase, scoped } = await import(path.join(root, 'packages/adapters/db-kysely/dist/index.js'));
const exec = promisify(execFile);

const HOST = process.env.BENCH_HOST ?? '127.0.0.1:55432';
const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 5000);
const CLIENTS = Number(process.env.BENCH_CLIENTS ?? 20);
const WARMUP = 500;
const CHUNK_REQUESTS = Number(process.env.BENCH_CHUNK_REQUESTS ?? 500);
const CHUNK_WARMUP = 50;
const DB = 'grimoire_bench';
const url = (role) => `postgres://${role}:grimoire-dev@${HOST}/${DB}`;

// Deterministic pseudo-random, so the three cases see the same request sequence.
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

async function seedData(admin) {
  const q = (s, p) => admin.query(s, p);
  const [{ shared_buffers: sb, jit }] = await q(`select current_setting('shared_buffers') as shared_buffers, current_setting('jit') as jit`);
  console.log(`server: shared_buffers=${sb} jit=${jit}`);
  await q(`insert into tenants (id, name) select 'small' || g, 'small' || g from generate_series(1, 40) g union all select 'big', 'big'`);
  await q(`insert into users (descope_user_id, email, name, role, tenant_id) select id || '-u', id || '@example.com', id, 'admin', id from tenants where id <> 'legacy'`);
  await q(`
    insert into collections (name, position, created_by, tenant_id)
    select 'c' || n, lpad(n::text, 4, '0'), u.id, u.tenant_id
      from (select id as tenant_id, case when id = 'big' then 60 else 1 end as cnt from tenants where id <> 'legacy') t
      cross join lateral generate_series(1, t.cnt) n
      join users u on u.tenant_id = t.tenant_id`);
  await q(`
    insert into pages (collection_id, created_by, tenant_id, title, position, markdown, text_content)
    select c.id, c.created_by, c.tenant_id, 'page ' || n, lpad(n::text, 5, '0'), repeat('word ', 800), repeat('word ', 800)
      from collections c cross join lateral generate_series(1, case when c.tenant_id = 'big' then 133 else 50 end) n where c.tenant_id <> 'legacy'`);
  // Chains of up to three levels, so the breadcrumb has work to do.
  await q(`
    with r as (select id, lag(id) over (partition by collection_id order by position) as prev, row_number() over (partition by collection_id order by position) as rn from pages)
    update pages p set parent_id = r.prev from r where r.id = p.id and r.rn % 4 <> 1`);
  // 14 chunks of 768 dimensions per page (140k rows), with the storage the chunk table gets in migration 0013 so the vectors stay in the heap.
  await q('alter table page_chunks alter column embedding set storage main');
  // The aggregate names the inner series d.n, so it belongs to the lateral subquery; `0 * g` keeps that subquery correlated, so it runs again for each g.
  await q(`create table bench_vectors as select g as id, x.a::vector as v from generate_series(1, 500) g cross join lateral (select array_agg((random() - 0.5 + 0 * g + 0 * d.n)::real) as a from generate_series(1, 768) as d(n)) x`);
  await q(`
    insert into page_chunks (page_id, tenant_id, chunk_index, model, content_hash, char_start, char_end, token_count, embedding)
    select p.id, p.tenant_id, n, 'multilingual-e5-base', decode(repeat('ab', 32), 'hex'), n * 100, n * 100 + 100, 100, v.v
      from pages p cross join generate_series(0, 13) n join bench_vectors v on v.id = 1 + (abs(hashtext(p.id::text)::bigint) + n) % 500`);
  await q('drop table bench_vectors');
  await q('vacuum analyze');
  const [{ c, p }] = await q(`select (select count(*) from collections where tenant_id <> 'legacy')::int as c, (select count(*) from pages)::int as p`);
  console.log(`data: ${c} collections, ${p} pages, 41 tenants (the migration's legacy tenant holds no pages and gets no requests)`);
}

async function loadTargets(admin) {
  const pages = await admin.query(`select id, collection_id, tenant_id from pages`);
  const byTenant = new Map();
  for (const r of pages) {
    const t = byTenant.get(r.tenant_id) ?? { pages: [], collections: new Set() };
    t.pages.push(r.id); t.collections.add(r.collection_id); byTenant.set(r.tenant_id, t);
  }
  const small = [...byTenant.keys()].filter((t) => t !== 'big');
  // Half of the requests are the big tenant's, the rest are spread over the small ones.
  for (const t of byTenant.values()) t.all = [...t.collections];
  return Array.from({ length: REQUESTS + WARMUP }, () => {
    const tenant = rnd() < 0.5 ? 'big' : pick(small);
    const t = byTenant.get(tenant);
    return { tenant, page: pick(t.pages), collection: pick([...t.collections]), all: t.all };
  });
}

const PAGE = `select id, url_id, collection_id, parent_id, position, title, icon, created_by, last_edited_by, markdown, text_content from pages p
               where id = $1 and tenant_id = $2 and deleted_at is null and exists (select 1 from collections c where c.id = p.collection_id and c.deleted_at is null)`;
const BREADCRUMB = `with recursive up as (select id, parent_id, title, 1 as d from pages where id = $1
                      union all select p.id, p.parent_id, p.title, up.d + 1 from pages p join up on p.id = up.parent_id)
                    select id, title from up where id <> $2 order by d desc`;
const pageOpen = (tx, r) => tx.query(PAGE, [r.page, r.tenant]).then(async (rows) => { if (rows[0]?.parent_id) await tx.query(BREADCRUMB, [rows[0].parent_id, r.page]); });
const treeRead = async (tx, r) => {
  await tx.query('set transaction isolation level repeatable read');
  const live = await tx.query('select 1 from collections where id = $1 and tenant_id = $2 and deleted_at is null', [r.collection, r.tenant]);
  if (live.length > 0) await tx.query('select id, url_id, parent_id, position, title, icon from pages where collection_id = $1 and deleted_at is null order by position, id', [r.collection]);
};
// The semantic search statement of embeddings.search (db-kysely), over the seeded chunks.
const QUERY_VECTOR = `[${Array.from({ length: 768 }, () => (rnd() - 0.5).toFixed(4)).join(',')}]`;
const CHUNK_SEARCH = `with nearest as (
           select c.page_id, c.chunk_index, c.char_start, c.char_end, c.embedding <=> $1::vector as distance
             from page_chunks c join pages p on p.id = c.page_id
            where c.model = $2 and c.tenant_id = $6 and p.tenant_id = $6 and p.deleted_at is null
              and p.collection_id = any($3::uuid[])
              and ($4::uuid is null or p.collection_id = $4)
              and 1 - (c.embedding <=> $1::vector) >= $5
            order by distance, c.page_id, c.chunk_index
            limit 300),
         best as (select distinct on (page_id) * from nearest order by page_id, distance, chunk_index)
         select b.page_id, b.chunk_index, b.char_start, b.char_end, 1 - b.distance as similarity,
                substr(p.text_content, b.char_start + 1, least(b.char_end - b.char_start, 4000)) as text, p.title, p.url_id, p.collection_id
           from best b join pages p on p.id = b.page_id
          order by b.distance, b.page_id
          limit $7`;
const chunkSearch = (tx, r) => tx.query(CHUNK_SEARCH, [QUERY_VECTOR, 'multilingual-e5-base', r.all, null, -1, r.tenant, 20]);
const OPS = { 'page-open': pageOpen, 'tree-read': treeRead, 'chunk-search': chunkSearch };
// [warm-up, measured] requests: the chunk search scans every chunk of the tenant, so it gets fewer.
const sizes = (op) => (op === 'chunk-search' ? [CHUNK_WARMUP, CHUNK_REQUESTS] : [WARMUP, REQUESTS]);

async function measure(app, mode, op, targets) {
  const run = OPS[op];
  const exec1 = (r) => (mode === 'plain' ? app.transaction((tx) => run(tx, r)) : scoped(app, r.tenant).transaction((tx) => run(tx, r)));
  const [warmup, count] = sizes(op);
  for (const r of targets.slice(0, warmup)) await exec1(r);
  const work = targets.slice(warmup, warmup + count);
  const lat = [];
  let next = 0;
  await Promise.all(Array.from({ length: CLIENTS }, async () => {
    while (next < work.length) {
      const r = work[next++];
      const t0 = performance.now();
      await exec1(r);
      lat.push(performance.now() - t0);
    }
  }));
  lat.sort((a, b) => a - b);
  const at = (p) => lat[Math.min(lat.length - 1, Math.ceil(p * lat.length) - 1)];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

/** Switches row-level security off (`on` false: returns the tables that had it) or back on for `tables`, as the administrator. The policies themselves stay as the migrations made them. */
async function rowSecurity(admin, on, tables) {
  const list = tables ?? (await admin.query(`select relname from pg_class where relkind = 'r' and relrowsecurity and relnamespace = 'public'::regnamespace order by 1`)).map((r) => r.relname);
  if (list.length === 0) throw new Error('no table has row-level security after the migrations: there is nothing to measure');
  for (const t of list) await admin.query(`alter table ${t} ${on ? 'enable' : 'disable'} row level security`);
  return list;
}

const sysql = createDatabase(url('grimoire_admin').replace(`/${DB}`, '/postgres'), { maxConnections: 1 });
await sysql.query(`drop database if exists ${DB} with (force)`);
await sysql.query(`create database ${DB} owner grimoire_migrator`);
await sysql.close();
await exec(process.execPath, [path.join(root, 'apps/server/dist/cli.js'), 'migrate'], { env: { ...process.env, GRIMOIRE_DATABASE_MIGRATION_URL: url('grimoire_migrator') } });

const admin = createDatabase(url('grimoire_admin'), { maxConnections: 2 });
const app = createDatabase(url('grimoire_app'), { maxConnections: CLIENTS });
const results = [];
try {
  await seedData(admin);
  const targets = await loadTargets(admin);
  // The migrations made the policies (0014): off for the two phases without them, then back on, so the third phase measures the policies the product ships.
  const secured = await rowSecurity(admin, false);
  for (const mode of ['plain', 'scoped']) for (const op of Object.keys(OPS)) results.push({ mode, op, ...(await measure(app, mode, op, targets)) });
  await rowSecurity(admin, true, secured);
  const policies = await admin.query(`select c.relname as t, string_agg(p.polname, '+' order by p.polname) as p from pg_policy p join pg_class c on c.oid = p.polrelid group by 1 order by 1`);
  console.log(`policies on: ${policies.map((r) => `${r.t} (${r.p})`).join(', ')}`);
  for (const op of Object.keys(OPS)) results.push({ mode: 'policy', op, ...(await measure(app, 'policy', op, targets)) });
} finally {
  await app.close();
  await admin.close();
}

const f = (x) => x.toFixed(2).padStart(8);
const pct = (a, b) => `${((a / b - 1) * 100).toFixed(1)}%`.padStart(8);
console.log(`\n${REQUESTS} requests after ${WARMUP} warm-up (chunk-search: ${CHUNK_REQUESTS} after ${CHUNK_WARMUP}), ${CLIENTS} concurrent clients (ms)`);
console.log('case          mode        p50      p95      p99   p95 vs plain  p95 vs scoped');
for (const op of Object.keys(OPS)) {
  const of = (mode) => results.find((r) => r.op === op && r.mode === mode);
  for (const mode of ['plain', 'scoped', 'policy']) {
    const r = of(mode);
    console.log(`${op.padEnd(13)} ${mode.padEnd(7)} ${f(r.p50)} ${f(r.p95)} ${f(r.p99)} ${mode === 'plain' ? ''.padStart(8) : pct(r.p95, of('plain').p95)} ${mode === 'policy' ? pct(r.p95, of('scoped').p95) : ''.padStart(8)}`);
  }
}
const worst = Math.max(...Object.keys(OPS).flatMap((op) => {
  const of = (mode) => results.find((r) => r.op === op && r.mode === mode).p95;
  return [of('scoped') / of('plain'), of('policy') / of('scoped')];
}));
console.log(`\nworst step growth of p95: ${((worst - 1) * 100).toFixed(1)}% (the plan stops at more than 20%)`);
