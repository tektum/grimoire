import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest';
import { buildZip } from '../import/hostile/zip-builder.js';

// M7-T07, the restart scenario: an import of 400 generated pages is started on the running stack, the application container is killed in the middle of it (`docker kill`, then `docker stop`, the graceful
// one) and started again, and the import reaches `done` with every page created exactly once and no attachment row twice. The stack is the one `make up` started (the application with every role, PostgreSQL, the
// file store, `make files-setup` done); the test recreates the application container with GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS=20 (so that a run the killed container left is taken back after 20 seconds, not
// 15 minutes) and puts it back as it was afterwards. Written for the stack: it needs Docker and nothing else, and says so when the stack is not there.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const BASE = 'http://127.0.0.1:8080';
const PAGES = 400;
const IMAGES = 8;
/** About 12 KB of Markdown a page: 400 of them take the importer long enough to be interrupted in the middle (a smaller page may be done before the test has looked). */
const PAGE_PARAGRAPHS = 60;
const run = promisify(execFile);
const compose = (args: string[], env: NodeJS.ProcessEnv = process.env) => run('docker', ['compose', '-p', 'grimoire', ...args], { cwd: root, env, maxBuffer: 64 * 1024 * 1024 });
/** Waits, in real time (a container restarts and an import runs on the platform's clock; no fake clock can stand in), until `probe` answers something: vi.waitFor, not a pause of a guessed length. */
const poll = <T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>, interval = 250): Promise<T> =>
  vi.waitFor(
    async () => {
      const found = await probe();
      if (found === undefined) throw new Error(`waiting for ${what}`);
      return found;
    },
    { timeout: timeoutMs, interval },
  );

function devSecret(): string {
  const fromEnv = process.env['GRIMOIRE_DEV_TOKEN_SECRET'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const found = /^GRIMOIRE_DEV_TOKEN_SECRET=(.+)$/m.exec(readFileSync(path.join(root, '.env'), 'utf8'));
  if (found?.[1] === undefined) throw new Error('GRIMOIRE_DEV_TOKEN_SECRET is neither in the environment nor in .env: run `make up` first');
  return found[1].trim();
}
const token = (): string => `dev:${devSecret()}:m7-restart:admin`;
const api = (method: string, url: string, body?: unknown): Promise<Response> =>
  fetch(`${BASE}${url}`, { method, headers: { authorization: `Bearer ${token()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** The 1x1 PNG every image of the archive is. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64');

function archive(): Buffer {
  const entries = [] as { name: string; data: Buffer }[];
  const paragraph = 'A paragraph of the page, long enough to take the converter a moment and to give the archive a size: nothing in it is a link, a table or a name. '.repeat(2);
  for (let i = 1; i <= PAGES; i += 1) {
    const n = String(i).padStart(4, '0');
    const image = i <= IMAGES ? `\n![picture ${String(i)}](img-${String(i)}.png)\n` : '';
    entries.push({ name: `docs/page-${n}.md`, data: Buffer.from(`# Page ${n}\n${image}\n${Array.from({ length: PAGE_PARAGRAPHS }, () => paragraph).join('\n\n')}\n`) });
  }
  for (let i = 1; i <= IMAGES; i += 1) entries.push({ name: `docs/img-${String(i)}.png`, data: PNG });
  return buildZip(entries);
}

interface ImportState {
  status: string;
  counts: { pagesTotal: number; pagesDone: number; attachments: number; skipped: number; failed: number };
  error: string | null;
}
/** What each read of the import said and when (seconds since the test file started): the progress over time, for the dump of a failure. The last 60. */
const samples: string[] = [];
const t0 = Date.now();
const stateOf = async (id: string): Promise<ImportState> => {
  const res = await api('GET', `/v1/imports/${id}`);
  if (res.status !== 200) throw new Error(`GET /v1/imports/${id}: ${String(res.status)} ${await res.text()}`);
  const state = (await res.json()) as ImportState;
  samples.push(`${String(Math.round((Date.now() - t0) / 1000))}s ${state.status} ${String(state.counts.pagesDone)}/${String(state.counts.pagesTotal)}`);
  if (samples.length > 60) samples.shift();
  return state;
};

async function waitReady(timeoutMs = 120_000): Promise<void> {
  await poll(
    'the application to answer /readyz',
    timeoutMs,
    async () => {
      try {
        return (await fetch(`${BASE}/readyz`)).ok ? true : undefined;
      } catch {
        return undefined; // not up yet
      }
    },
    500,
  );
}

/** Recreates the application container with the settings of a run of this test (or, with `expire` false, without them: as the stack was). */
async function recreateApp(expire: boolean): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, GRIMOIRE_S3_PUBLIC_ENDPOINT: process.env['GRIMOIRE_S3_PUBLIC_ENDPOINT'] ?? 'http://127.0.0.1:8333' };
  if (expire) env['GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS'] = '20';
  else delete env['GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS'];
  await compose(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'app'], env);
  await waitReady();
}

async function psql(sql: string): Promise<string> {
  return (await compose(['exec', '-T', 'postgres', 'psql', '-U', 'grimoire_admin', '-d', 'grimoire', '-v', 'ON_ERROR_STOP=1', '-Atc', sql])).stdout.trim();
}

async function psqlExpanded(sql: string): Promise<string> {
  return (await compose(['exec', '-T', 'postgres', 'psql', '-U', 'grimoire_admin', '-d', 'grimoire', '-x', '-c', sql])).stdout.trim();
}

/** The queues are defined by `migrate` (not by the application as it starts): the expiry of a queue is the one the migration was given, so the migration runs again with the setting of this test (or without it). */
async function runMigrate(expire: boolean): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (expire) env['GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS'] = '20';
  else delete env['GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS'];
  await compose(['--profile', 'tools', 'run', '--rm', 'migrate'], env);
}

/** What a failure needs to be understood without a second run: the container and its settings, the queue and the job of the import, the import row, how far it got over time, and the log of the application. Nothing here can fail the test. */
let lastImport: string | undefined;
async function dump(): Promise<void> {
  const show = async (what: string, read: () => Promise<string>): Promise<void> => {
    try {
      console.log(`[restart-dump] ${what}:\n${(await read()).slice(0, 6000)}`);
    } catch (error) {
      console.log(`[restart-dump] ${what}: could not be read: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
    }
  };
  await show('the application container', async () => (await compose(['ps', '-a', 'app'])).stdout);
  await show('its settings of the jobs, the semantic search and the store address', async () => {
    const id = (await compose(['ps', '-aq', 'app'])).stdout.trim();
    const env = (await run('docker', ['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', id])).stdout;
    return env
      .split('\n')
      .filter((l) => /^GRIMOIRE_(JOBS|SEMANTIC|S3_PUBLIC)/.test(l))
      .join('\n');
  });
  await show('the queues import and import-sweep', () => psqlExpanded("select name, policy, retry_limit, expire_seconds from pgboss.queue where name in ('import', 'import-sweep')"));
  if (lastImport !== undefined) {
    await show('the import row', () => psqlExpanded(`select * from imports where id = '${lastImport}'`));
    await show('the job of the import', async () => {
      const table = await psql("select table_name from pgboss.queue where name = 'import'");
      return psqlExpanded(`select * from pgboss.${table.replace(/[^a-z0-9_]/gi, '')} where name = 'import' and data->>'importId' = '${lastImport}'`);
    });
  }
  await show('the reads of the import over time', async () => samples.join('\n'));
  await show('the last 200 lines of the application log', async () => (await compose(['logs', '--no-log-prefix', '--tail', '200', 'app'])).stdout);
}

/** Starts the import of the archive into a new collection and returns its ids. */
async function startImport(zip: Buffer): Promise<{ importId: string; collectionId: string }> {
  const made = await api('POST', '/v1/collections', { name: `Restart ${String(Date.now())}`, defaultPermission: 'read_write' });
  expect(made.status, await made.clone().text()).toBe(201);
  const collectionId = ((await made.json()) as { id: string }).id;
  const created = await api('POST', '/v1/imports', { collectionId, fileName: 'restart.zip', size: zip.length, profile: 'markdown_zip' });
  expect(created.status, await created.clone().text()).toBe(201);
  const { id: importId, upload } = (await created.json()) as { id: string; upload: { url: string; headers: Record<string, string> } };
  lastImport = importId;
  const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: zip });
  expect(put.ok, `the PUT of the archive to the file store: ${String(put.status)}`).toBe(true);
  const started = await api('POST', `/v1/imports/${importId}/start`);
  expect(started.status, await started.clone().text()).toBeLessThan(300);
  return { importId, collectionId };
}

/** Waits until the import is running and has made some of its pages (and is not yet done): the moment to interrupt it. */
async function waitMidRun(importId: string): Promise<ImportState> {
  const found = await poll(
    'the import to be in the middle of its run',
    120_000,
    async () => {
      const state = await stateOf(importId);
      if (state.status === 'done' || state.status === 'failed') return { ended: true as const, state };
      return state.status === 'running' && state.counts.pagesDone >= 40 && state.counts.pagesDone < PAGES - 40 ? { ended: false as const, state } : undefined;
    },
    100,
  );
  if (found.ended) throw new Error(`the import ended (${found.state.status}, ${String(found.state.counts.pagesDone)} pages) before it could be interrupted: make the pages larger (PAGE_PARAGRAPHS)`);
  return found.state;
}

async function waitDone(importId: string, timeoutMs: number): Promise<ImportState> {
  const found = await poll(
    `the import to be done (${String(timeoutMs / 1000)} s)`,
    timeoutMs,
    async () => {
      const state = await stateOf(importId);
      return state.status === 'done' || state.status === 'failed' || state.status === 'cancelled' ? state : undefined;
    },
    1000,
  );
  if (found.status !== 'done') throw new Error(`the import ended as ${found.status}: ${JSON.stringify(found)}`);
  return found;
}

/** The outcome that has to hold after either way of interrupting it: done with all the pages once, and every row once. */
async function expectExactlyOnce(importId: string, collectionId: string): Promise<void> {
  const done = await waitDone(importId, 300_000);
  expect(done.counts, JSON.stringify(done)).toMatchObject({ pagesDone: PAGES, attachments: IMAGES, failed: 0, skipped: 0 });
  const items: { kind: string; status: string; pageId: string | null; path: string }[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const res = await api('GET', `/v1/imports/${importId}/items?limit=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: typeof items; nextCursor: string | null };
    items.push(...body.items);
    cursor = body.nextCursor;
    if (cursor === null) break;
  }
  const pages = items.filter((i) => i.kind === 'page');
  expect(pages.length, 'one item for each page').toBe(PAGES);
  expect(new Set(pages.map((p) => p.path)).size, 'each path once').toBe(PAGES);
  expect(new Set(pages.map((p) => p.pageId)).size, 'each page once').toBe(PAGES);
  expect(await psql(`select count(*) from pages where collection_id = '${collectionId}' and deleted_at is null`), 'the pages of the collection').toBe(String(PAGES));
  expect(await psql(`select count(distinct title) from pages where collection_id = '${collectionId}' and deleted_at is null`), 'a page for each title, none twice').toBe(String(PAGES));
  const rows = await psql(`select count(*) || ' ' || count(distinct (page_id, file_name)) from attachments where page_id in (select id from pages where collection_id = '${collectionId}')`);
  expect(rows, 'attachment rows: all of them, and none twice for the same page and name').toBe(`${String(IMAGES)} ${String(IMAGES)}`);
}

describe('an import of 400 pages across a restart of the application', () => {
  let zip: Buffer;
  let recreated = false;
  beforeAll(async () => {
    try {
      await waitReady(5_000);
    } catch {
      throw new Error('the stack is not running: `make up` and `make files-setup` first (the application, PostgreSQL and the file store)');
    }
    zip = archive();
    recreated = true;
    await recreateApp(true);
    await runMigrate(true);
    // What the test relies on, asked before it is relied on: the queue of the imports has the expiry this test set. If not, the setting does not reach the queue, and the test says that, not a timeout 5 minutes later.
    const expiry = await psql("select expire_seconds from pgboss.queue where name = 'import'");
    if (expiry !== '20') {
      await dump();
      throw new Error(
        `the queue of the imports expires a run after ${expiry} seconds, not the 20 this test asked for: GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS does not reach the queue (the migrate service must pass it through, and the migrate command must hand config.jobs.importExpireSeconds to jobQueues())`,
      );
    }
    // The first request of a person creates their row, and only `GET /v1/me` may be that first request (any other from someone the application has not seen is 403): the person signs in first, as an administrator.
    const me = await api('GET', '/v1/me');
    expect(me.status, await me.clone().text()).toBe(200);
    expect(((await me.json()) as { role: string }).role).toBe('admin');
  }, 240_000);
  afterAll(async () => {
    if (recreated) {
      // only a stack that was found running and was changed here is put back
      await recreateApp(false);
      await runMigrate(false);
    }
  }, 240_000);

  it('survives docker kill: the run the container left is taken back after the expiry, and every page and attachment exists once', async () => {
    onTestFailed(dump);
    const { importId, collectionId } = await startImport(zip);
    const mid = await waitMidRun(importId);
    await compose(['kill', '-s', 'SIGKILL', 'app']);
    await compose(['start', 'app']);
    await waitReady();
    console.log(JSON.stringify({ restart: 'kill', pagesDoneWhenKilled: mid.counts.pagesDone }));
    await expectExactlyOnce(importId, collectionId);
  }, 600_000);

  it('survives docker stop (graceful): the run continues within 10 seconds of the restart, and every page and attachment exists once', async () => {
    onTestFailed(dump);
    const { importId, collectionId } = await startImport(zip);
    const mid = await waitMidRun(importId);
    await compose(['stop', '-t', '30', 'app']);
    await compose(['start', 'app']);
    await waitReady();
    const ready = await stateOf(importId);
    // The run goes on by itself right after the restart: some progress, or the end, within 10 seconds.
    const progressed = await poll('progress after the restart', 10_000, async () => {
      const now = await stateOf(importId);
      return now.status === 'done' || now.counts.pagesDone > ready.counts.pagesDone ? true : undefined;
    }).then(
      () => true,
      () => false,
    );
    console.log(JSON.stringify({ restart: 'stop', pagesDoneWhenStopped: mid.counts.pagesDone, pagesDoneAtReady: ready.counts.pagesDone, progressedWithin10s: progressed }));
    expect(progressed, `the import made no progress in the 10 seconds after the restart: ${JSON.stringify(ready)}`).toBe(true);
    await expectExactlyOnce(importId, collectionId);
  }, 600_000);
});
