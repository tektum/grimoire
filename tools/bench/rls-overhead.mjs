// BENCHMARK, not a test and not part of the product. Run by .github/workflows/bench-rls.yml (workflow_dispatch only) against a Postgres started with the staging
// parameters (tools/bench/compose.bench.yaml). It measures what `scoped()` and the row-level security policies of docs/tenancy.md step 4 cost per request:
//   plain   the runtime pool, the same SQL, no tenant setting
//   scoped  scoped(db, tenant): `begin; set local app.tenant` in one round trip, no policies
//   policy  scoped() with the draft policies of migration 0013 enabled (tenant_isolation on every tenant table)
// for two requests: page-open (pages.get: the page, then its breadcrumb) and tree-read (collections.tree). Data: 100 collections, about 10k pages of about 4 KB in 41 tenants (40 small, one big).
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
const DB = 'grimoire_bench';
const url = (role) => `postgres://${role}:grimoire-dev@${HOST}/${DB}`;
const TENANT_TABLES = ['users', 'groups', 'group_members', 'collections', 'collection_access', 'pages', 'revisions', 'attachments', 'audit_events', 'idempotency_keys', 'imports', 'import_items'];

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
      from collections c cross join lateral generate_series(1, case when c.tenant_id = 'big' then 133 else 50 end) n`);
  // Chains of up to three levels, so the breadcrumb has work to do.
  await q(`
    with r as (select id, lag(id) over (partition by collection_id order by position) as prev, row_number() over (partition by collection_id order by position) as rn from pages)
    update pages p set parent_id = r.prev from r where r.id = p.id and r.rn % 4 <> 1`);
  await q('vacuum analyze');
  const [{ c, p }] = await q(`select (select count(*) from collections)::int as c, (select count(*) from pages)::int as p`);
  console.log(`data: ${c} collections, ${p} pages, 41 tenants`);
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
  return Array.from({ length: REQUESTS + WARMUP }, () => {
    const tenant = rnd() < 0.5 ? 'big' : pick(small);
    const t = byTenant.get(tenant);
    return { tenant, page: pick(t.pages), collection: pick([...t.collections]) };
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
const OPS = { 'page-open': pageOpen, 'tree-read': treeRead };

async function measure(app, mode, op, targets) {
  const run = OPS[op];
  const exec1 = (r) => (mode === 'plain' ? app.transaction((tx) => run(tx, r)) : scoped(app, r.tenant).transaction((tx) => run(tx, r)));
  for (const r of targets.slice(0, WARMUP)) await exec1(r);
  const work = targets.slice(WARMUP);
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

async function enablePolicies(admin) {
  const claim = `nullif(current_setting('app.tenant', true), '')`;
  for (const t of TENANT_TABLES) {
    await admin.query(`alter table ${t} enable row level security`);
    await admin.query(`create policy tenant_isolation on ${t} to grimoire_app using (tenant_id = ${claim}) with check (tenant_id = ${claim})`);
  }
  await admin.query(`alter table tenants enable row level security`);
  await admin.query(`create policy tenant_self on tenants for select to grimoire_app using (id = ${claim})`);
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
  for (const mode of ['plain', 'scoped']) for (const op of Object.keys(OPS)) results.push({ mode, op, ...(await measure(app, mode, op, targets)) });
  await enablePolicies(admin);
  for (const op of Object.keys(OPS)) results.push({ mode: 'policy', op, ...(await measure(app, 'policy', op, targets)) });
} finally {
  await app.close();
  await admin.close();
}

const f = (x) => x.toFixed(2).padStart(8);
const pct = (a, b) => `${((a / b - 1) * 100).toFixed(1)}%`.padStart(8);
console.log(`\n${REQUESTS} requests after ${WARMUP} warm-up, ${CLIENTS} concurrent clients (ms)`);
console.log('case       mode        p50      p95      p99   p95 vs plain  p95 vs scoped');
for (const op of Object.keys(OPS)) {
  const of = (mode) => results.find((r) => r.op === op && r.mode === mode);
  for (const mode of ['plain', 'scoped', 'policy']) {
    const r = of(mode);
    console.log(`${op.padEnd(10)} ${mode.padEnd(7)} ${f(r.p50)} ${f(r.p95)} ${f(r.p99)} ${mode === 'plain' ? ''.padStart(8) : pct(r.p95, of('plain').p95)} ${mode === 'policy' ? pct(r.p95, of('scoped').p95) : ''.padStart(8)}`);
  }
}
const worst = Math.max(...Object.keys(OPS).flatMap((op) => {
  const of = (mode) => results.find((r) => r.op === op && r.mode === mode).p95;
  return [of('scoped') / of('plain'), of('policy') / of('scoped')];
}));
console.log(`\nworst step growth of p95: ${((worst - 1) * 100).toFixed(1)}% (the plan stops at more than 20%)`);
