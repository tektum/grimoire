import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { requiredGracePeriodMs } from '../../src/lifecycle/budget.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const schemaDir = path.join(root, 'packages/adapters/config-env/src');

/** Settings the local Compose app deliberately does not pass, each with the reason. Everything else the loader knows must appear in compose.yaml. */
const NOT_PASSED: Readonly<Record<string, string>> = {
  GRIMOIRE_HOST: 'the image sets 0.0.0.0 (a container must listen on all its interfaces)',
  GRIMOIRE_PORT: 'fixed at 8080: the published port, the exposed port and the healthcheck use it',
  GRIMOIRE_COLLAB_PORT: 'collaboration shares the HTTP port in this stack; a second port would need its own published port',
  GRIMOIRE_REQUIRE_HANDSHAKE: 'the default (off) is right for the local stack; a deployment turns it on',
  GRIMOIRE_MIN_CLIENT_VERSION: 'the default (0.0.0) accepts every client; a deployment raises it',
  GRIMOIRE_HTTP_USER_LIMIT_PER_MINUTE: 'the default limit suits the local stack',
  GRIMOIRE_HTTP_ADDRESS_LIMIT_PER_MINUTE: 'the default limit suits the local stack',
  GRIMOIRE_HTTP_ADDRESS_CEILING_PER_MINUTE: 'the default limit suits the local stack',
  GRIMOIRE_S3_ADMIN_ACCESS_KEY: 'the running server never holds the admin key',
  GRIMOIRE_WEB_ROOT: 'the local stack serves the web client from its own static server (apps/web/scripts/serve.mjs); a deployment sets it to the built client in the image',
  GRIMOIRE_DATABASE_ADMIN_URL: 'only the db-setup step holds the administrator connection; the server refuses to start with it',
  GRIMOIRE_DB_APP_PASSWORD: 'only the db-setup step holds the role passwords; the server refuses to start with it',
  GRIMOIRE_DB_MIGRATOR_PASSWORD: 'only the db-setup step holds the role passwords; the server refuses to start with it',
  GRIMOIRE_S3_ADMIN_SECRET_KEY: 'the running server never holds the admin key',
  GRIMOIRE_S3_CREATE_ONLY_HEADER: 'M5-T02a passes it',
  GRIMOIRE_S3_CORS_MODE: 'M5-T02a passes it',
  GRIMOIRE_FILES_MAX_BYTES: 'M5-T02a passes it',
  GRIMOIRE_FILES_ALLOWED_TYPES: 'M5-T02a passes it',
  GRIMOIRE_FILES_PENDING_MAX_PER_USER: 'M5-T02a passes it',
  GRIMOIRE_IMPORT_MAX_ZIP_BYTES: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_IMPORT_MAX_ENTRIES: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_IMPORT_MAX_UNCOMPRESSED_BYTES: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_IMPORT_MAX_RATIO: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_IMPORT_MAX_ENTRY_BYTES: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_IMPORT_MAX_TABLE_BYTES: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_IMPORT_ALLOW_NESTED_ZIPS: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_IMPORT_FETCH_REMOTE_IMAGES: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_IMPORT_REMOTE_MAX_IMAGES: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_IMPORT_REMOTE_MAX_BYTES: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_IMPORT_REMOTE_TIMEOUT_SECONDS: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_IMPORT_REMOTE_TOTAL_SECONDS: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_IMPORT_CONCURRENCY: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_JOBS_STOP_GRACE_MS: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_JOBS_PURGE_CRON: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_JOBS_UPLOAD_CLEANUP_CRON: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_JOBS_REVISION_CRON: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_JOBS_SWEEP_CRON: 'M7-T00 declares it; the task that uses it passes it',
  GRIMOIRE_SEARCH_STATEMENT_TIMEOUT_MS: 'M7-T00 declares it; the task that uses it passes it',
};

it('every GRIMOIRE_* setting the loader reads appears in compose.yaml or is listed above with a reason', () => {
  const known = new Set(
    readdirSync(schemaDir).filter((f) => f.endsWith('.ts'))
      .flatMap((f) => readFileSync(path.join(schemaDir, f), 'utf8').match(/GRIMOIRE_[A-Z0-9]+(?:_[A-Z0-9]+)*/g) ?? [])
      .filter((n) => !n.endsWith('_') && n !== 'GRIMOIRE_S3'), // GRIMOIRE_S3 alone is a prefix named in a message
  );
  expect(known.size).toBeGreaterThan(30);
  const compose = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  const missing = [...known].filter((n) => !(n in NOT_PASSED) && !new RegExp(`^\\s+${n}:`, 'm').test(compose)).sort();
  expect(missing).toEqual([]);
  for (const n of Object.keys(NOT_PASSED)) expect(known.has(n), `${n} is listed as not passed but the loader does not read it`).toBe(true);
});

/** Settings the server refuses to start without in local mode, which is what the Compose app runs in. */
const REQUIRED = ['GRIMOIRE_DEV_TOKEN_SECRET', 'GRIMOIRE_DATABASE_URL', 'GRIMOIRE_ALLOWED_ORIGINS'];

it('every setting the server requires has a value in compose.yaml, or a generator the `up` target reaches', () => {
  const compose = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  const makefile = readFileSync(path.join(root, 'Makefile'), 'utf8');
  const envExample = readFileSync(path.join(root, '.env.example'), 'utf8');
  const prereqs = (target: string): string[] => (new RegExp(`^${target}:([^\\n]*)$`, 'm').exec(makefile)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  const reach = (target: string, seen = new Set<string>()): Set<string> => {
    for (const p of prereqs(target)) if (!seen.has(p)) { seen.add(p); reach(p, seen); }
    return seen;
  };
  const upReaches = reach('up');
  for (const name of REQUIRED) {
    const line = new RegExp(`^\\s+${name}:\\s*(.*)$`, 'm').exec(compose)?.[1]?.trim().replace(/^"|"$/g, '');
    expect(line, `${name} is not set in compose.yaml`).toBeDefined();
    // Every ${VAR}, ${VAR:-} and ${VAR:-default} anywhere in the value (a password inside a URL included) must have a value that Compose can read.
    const refs = [...(line ?? '').matchAll(/\$\{([A-Z0-9_]+)(:-([^}]*))?\}/g)].map((m) => ({ name: m[1] as string, hasDefault: m[2] !== undefined && (m[3] ?? '') !== '' }));
    const needs = refs.filter((r) => !r.hasDefault).map((r) => r.name);
    if ((line ?? '') !== '' && needs.length === 0) continue; // a fixed value, or only variables with a non-empty default
    for (const source of needs.length > 0 ? needs : [name]) {
    const inExample = new RegExp(`^${source}=.`, 'm').test(envExample);
    // A generator is a recipe (the tab-indented lines under the target's own line) that writes `NAME=`.
    const recipe = (target: string): string => new RegExp(`^${target.replace('.', '\\.')}:[^\\n]*\\n((?:\\t[^\\n]*\\n)*)`, 'm').exec(makefile)?.[1] ?? '';
    const generator = [...upReaches].find((t) => recipe(t).includes(`${source}=`));
    expect(inExample || generator !== undefined, `${source} (required by the server) has no value in compose.yaml or .env.example and no generator reachable from \`make up\``).toBe(true);
    }
  }
});

it('the app service gives the process at least its shutdown backstop plus the margin before Docker kills it (stop_grace_period)', () => {
  const compose = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  const grace = /^\s+stop_grace_period:\s*(\d+)s\s*$/m.exec(compose);
  expect(grace, 'compose.yaml must set stop_grace_period explicitly for the app service').not.toBeNull();
  const graceMs = Number(grace?.[1]) * 1000;
  // The committed file passes no save deadline of its own (the setting is empty unless the operator sets it), so the default of the loader applies.
  const schema = readFileSync(path.join(schemaDir, 'schema.ts'), 'utf8');
  const defaultSave = Number(/GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: field\(int\(1, MAX_INT\)\)\.default\((\d+)\)/.exec(schema)?.[1]);
  const defaultJobsGrace = Number(/GRIMOIRE_JOBS_STOP_GRACE_MS: field\(int\(1, MAX_INT\)\)\.default\(([\d_]+)\)/.exec(schema)?.[1]?.replaceAll('_', ''));
  expect(defaultSave).toBeGreaterThan(0);
  expect(defaultJobsGrace).toBeGreaterThan(0);
  expect(graceMs).toBeGreaterThanOrEqual(requiredGracePeriodMs(defaultSave, defaultJobsGrace));
});


const appBlock = (compose: string): string => /^ {2}app:\n([\s\S]*?)(?=^ {2}\S|^\S)/m.exec(compose)?.[1] ?? '';

it('the app service gets the runtime file store pair and never the admin pair, under any name', () => {
  const compose = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  const app = appBlock(compose);
  expect(app).toContain('GRIMOIRE_DEV_S3_APP_ACCESS_KEY');
  expect(app).toContain('GRIMOIRE_DEV_S3_APP_SECRET_KEY');
  expect(app).not.toMatch(/GRIMOIRE_S3_ADMIN_/);
  expect(app).not.toMatch(/GRIMOIRE_DEV_S3_(ACCESS|SECRET)_KEY|AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);
});

it('the runtime identity is rendered from .env, may only read, write and list the grimoire bucket, and differs from the admin identity', () => {
  const compose = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  const env = Object.fromEntries(
    readFileSync(path.join(root, '.env.example'), 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  expect(compose).toContain('-s3.config=/etc/seaweedfs/s3.json');
  expect(compose).toContain('"actions":["Read:${GRIMOIRE_S3_BUCKET:-grimoire}","Write:${GRIMOIRE_S3_BUCKET:-grimoire}","List:${GRIMOIRE_S3_BUCKET:-grimoire}"]');
  for (const v of ['ACCESS', 'SECRET']) {
    expect(env[`GRIMOIRE_DEV_S3_APP_${v}_KEY`]).toBeTruthy();
    expect(env[`GRIMOIRE_DEV_S3_APP_${v}_KEY`]).not.toBe(env[`GRIMOIRE_DEV_S3_${v}_KEY`]);
    expect(env[`GRIMOIRE_S3_${v}_KEY`]).toBe(env[`GRIMOIRE_DEV_S3_APP_${v}_KEY`]);
    expect(compose).not.toContain(env[`GRIMOIRE_DEV_S3_APP_${v}_KEY`]);
  }
});
