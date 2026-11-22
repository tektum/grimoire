import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, repoRoot, requireBuild, sqlAdmin, startServer } from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { connect, eventually, newPage, seedPage, StallProxy, synced, wsUrl } from './support.js';
import type { Client } from './support.js';

// The real server in local mode with development tokens: the same provisioning and authorisation path as production.
const DB = 'grimoire_t06_auth';
const SECRET = 'test-secret-0123456789abcdef';
const tok = (user: string, role: string): string => `dev:${SECRET}:${user}:${role}`;
const running: ServerProcess[] = [];
const clients: Client[] = [];
const proxies: StallProxy[] = [];
async function start(env: Record<string, string> = {}): Promise<ServerProcess> {
  const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_COLLAB_DEBOUNCE_MS: '200', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '500', ...env } });
  running.push(s);
  return s;
}
function client(s: ServerProcess, page: string, token: string): Client {
  const c = connect(wsUrl(s.port), page, token, { maxAttempts: 1 });
  clients.push(c);
  return c;
}
/** What a client learns from a refusal: the reason and the close codes. */
async function refusal(s: ServerProcess, page: string, token: string): Promise<{ failures: string[]; closes: number[] }> {
  const c = client(s, page, token);
  await eventually(() => (c.failures.length > 0 && c.closes.length > 0 ? true : undefined), 5000, 'refused and closed');
  return { failures: [...c.failures], closes: [...c.closes] };
}
const rowOf = async (sub: string) => (await sqlAdmin<{ id: string; role: string }>(DB, `select id::text, role from users where descope_user_id = '${sub}'`))[0];

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); }, 60_000);
afterEach(async () => {
  clients.splice(0).forEach((c) => { c.destroy(); });
  await Promise.all(running.splice(0).map((s) => s.kill()));
  for (const p of proxies.splice(0)) await p.stop();
});
afterAll(async () => { await dropTestDatabase(DB); });

describe('local mode: dev tokens through provisioning and the database authoriser', () => {
  it('dev:alice2:viewer connects read-only and creates the row with role viewer; dev:alice2:admin then connects read-write and the row is admin', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const v = client(s, page, tok('alice2', 'viewer'));
    await synced(v);
    expect(v.provider.authorizedScope).toBe('readonly');
    expect(await rowOf('alice2')).toMatchObject({ role: 'viewer' });
    const a = client(s, page, tok('alice2', 'admin'));
    await synced(a);
    expect(a.provider.authorizedScope).toBe('read-write');
    expect(await rowOf('alice2')).toMatchObject({ role: 'admin' });
    // last_edited_by = the row id (not the subject) is shown by save-columns.int.test.ts: its tokens carry 'alice', the column must be alice's id.
  }, 30_000);

  it('no token and a malformed token: invalid-token', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const none = client(s, page, '');
    await eventually(() => (none.closes.length > 0 ? true : undefined), 8000, 'no-token client closed');
    expect(none.provider.isAuthenticated).toBe(false);
    expect(none.provider.synced).toBe(false); // it never received the page before the pre-sign-in timeout closed it
    expect((await refusal(s, page, 'dev:nope')).failures).toEqual(['invalid-token']);
  }, 20_000);

  it('a missing page and a page the user cannot see give identical refusals (reason and close codes)', async () => {
    const s = await start();
    await sqlAdmin(DB, "insert into collections (id, name, position, created_by) values ('00000000-0000-4000-8000-0000000000d9', 'Closed', 'b0', '00000000-0000-4000-8000-000000000001') on conflict do nothing");
    const hidden = newPage();
    await sqlAdmin(DB, `insert into pages (id, collection_id) values ('${hidden}', '00000000-0000-4000-8000-0000000000d9')`);
    const missing = await refusal(s, newPage(), tok('bob', 'member'));
    const forbidden = await refusal(s, hidden, tok('bob', 'member'));
    expect(missing.failures).toEqual(['not-found']);
    expect(forbidden).toStrictEqual(missing);
  });

  it('a suspended user is refused forbidden; nothing is opened', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const c = client(s, page, tok('susan', 'member')); await synced(c); c.destroy();
    await sqlAdmin(DB, "update users set suspended_at = now() where descope_user_id = 'susan'");
    expect((await refusal(s, page, tok('susan', 'member'))).failures).toEqual(['forbidden']);
    expect(s.events.filter((e) => e['event'] === 'collab.refused' && e['detail'] === 'suspended')).toHaveLength(1);
  });

  it('database down during authorisation: try-again, never admitted, and the address is not banned', async () => {
    const proxy = await StallProxy.start(); proxies.push(proxy);
    const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: proxy.url(`${DB}`), GRIMOIRE_COLLAB_CONNECT_ATTEMPTS_PER_WINDOW: '2' } });
    running.push(s);
    const page = newPage(); await seedPage(DB, page);
    proxy.stall();
    for (let i = 0; i < 4; i++) expect((await refusal(s, page, tok('bob', 'member'))).failures).toEqual(['try-again']);
    proxy.release();
    const ok = client(s, page, tok('bob', 'member'));
    await synced(ok);
    expect(s.events.filter((e) => e['event'] === 'collab.upgrade_refused')).toEqual([]);
    expect(s.events.some((e) => e['event'] === 'collab.auth_unavailable' && e['source'] === 'database')).toBe(true);
  }, 60_000);
});

/** Every place a token could have been written: the captured log lines, a data-only dump of the test database and the server's temp dir. */
function canaryHits(canary: string, s: { output: string; tmp: string }, dump: string): string[] {
  const hits: string[] = [];
  if (s.output.includes(canary)) hits.push('log');
  if (dump.includes(canary)) hits.push('pg_dump');
  for (const f of readdirSync(s.tmp, { recursive: true, withFileTypes: true })) {
    if (f.isFile() && readFileSync(path.join(f.parentPath, f.name), 'utf8').includes(canary)) hits.push(`file:${f.name}`);
  }
  return hits;
}
async function dumpOf(db: string): Promise<string> {
  const name = (await sqlAdmin<{ d: string }>(db, 'select current_database() as d'))[0]?.d ?? db;
  return execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'pg_dump', '-U', 'grimoire_admin', '--data-only', name], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

describe('token scan (R4.8, R12.6)', () => {
  it('after a session with a unique canary token, the token is in no log line, no pg_dump --data-only output and no temp file; the scan sees a planted canary', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'grimoire-t06-'));
    try {
      const unique = `canary${String(Date.now())}`;
      const canary = tok(unique, 'member');
      const s = await start({ TMPDIR: tmp, GRIMOIRE_LOG_LEVEL: 'debug' });
      const page = newPage(); await seedPage(DB, page);
      const c = client(s, page, canary);
      await synced(c);
      c.text.insert(0, 'canary session');
      await eventually(async () => ((await sqlAdmin<{ n: string }>(DB, `select count(*) as n from pages where id = '${page}' and ydoc is not null`))[0]?.n === '1' ? true : undefined), 10_000, 'stored');
      c.destroy();
      const dump = await dumpOf(DB);
      expect(dump).toContain(unique); // the subject is stored as descope_user_id: the dump is real and complete
      expect(canaryHits(canary, { output: s.output, tmp }, dump)).toEqual([]);
      // test of the test: a canary planted in each place is found
      execFileSync('sh', ['-c', `printf %s '${canary}' > '${path.join(tmp, 'planted.txt')}'`]);
      expect(canaryHits(canary, { output: `${s.output}\n{"event":"x","t":"${canary}"}`, tmp }, `${dump}${canary}`)).toEqual(['log', 'pg_dump', 'file:planted.txt']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
