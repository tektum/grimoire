#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FileStorageError } from '@tektum/grimoire-core/ports/file-storage';
import { composeDbSetup, composeFilesSetup, composeSeed, composeTenantAdopt, runDbSetup, runFilesSetup, runTenantAdopt } from './composition.js';
import { composeMigrate } from './lifecycle/compose-migrate.js';
import { parseTenantAdoptArgs, TENANT_ADOPT_USAGE } from './lifecycle/tenant-adopt.js';
import { seedLocal } from './seed/index.js';

// Exit codes: 0 ok, 1 runtime failure, 2 usage or configuration error. Adapters come from composition.ts (S1); this file only runs and closes them.
const defaultDir = fileURLToPath(new URL('../../../db/migrations', import.meta.url)); // dist/ -> apps/server -> repo root

async function migrate(args: string[]): Promise<number> {
  let values: { dir?: string | undefined };
  try {
    values = parseArgs({ args, options: { dir: { type: 'string' } } }).values;
  } catch {
    process.stderr.write('usage: grimoire migrate [--dir <migrations directory>]\n'); // an unknown option or a missing value is a usage error (exit 2), not a crash
    return 2;
  }
  const composed = composeMigrate();
  if (!composed.ok) return composed.code;
  const { db, log } = composed.ctx;
  try {
    const { applied, jobTables } = await composed.migrate(values.dir ?? defaultDir);
    if (applied.length === 0) log.info('migrate.nothing_pending', {});
    for (const name of applied) log.info('migrate.applied', { migration: name });
    log.info('migrate.jobs_schema', { tables: jobTables });
    log.info('migrate.done', { applied: applied.length });
    return 0;
  } catch (e) {
    // Only the message: it names the migration; connection strings never appear in pg or Kysely messages.
    log.error('migrate.failed', { error: e instanceof Error ? e.message : 'unknown error' });
    return 1;
  } finally {
    await db.close().catch(() => undefined);
  }
}

/** `grimoire seed`: development rows, local mode only. Runs as the runtime role: it loads the server settings, like `grimoire` itself, and refuses unless they say local. */
async function seed(): Promise<number> {
  const composed = composeSeed();
  if (!composed.ok) return composed.code;
  const { db, log } = composed.ctx;
  try {
    await seedLocal(db);
    log.info('seed.done', {});
    return 0;
  } catch (e) {
    log.error('seed.failed', { error: e instanceof Error ? e.message : 'unknown error' });
    return 1;
  } finally {
    await db.close().catch(() => undefined);
  }
}

/**
 * `grimoire files-setup`: makes the bucket exist and its CORS rule the application's origins (`api` mode), or, when an
 * operator owns the rule (`external` mode), creates the bucket and checks the rule with the preflights a browser sends.
 * Runs on the host with the admin key, which only this command reads. Prints the bucket and the origins, never a key.
 */
async function filesSetup(): Promise<number> {
  const composed = composeFilesSetup();
  if (!composed.ok) return composed.code;
  const { setup, allowedOrigins, log } = composed.ctx;
  try {
    const checked = await runFilesSetup(setup, allowedOrigins);
    if (!checked.ok) {
      log.error('files_setup.cors_refused', { problem: checked.problem });
      return 1;
    }
    log.info('files_setup.done', {
      bucket: setup.bucket,
      origins: allowedOrigins,
      cors: setup.corsMode === 'external' ? 'external' : 'api',
    });
    return 0;
  } catch (e) {
    // A store refusal carries adapter-authored text only; anything else is named by its class.
    log.error('files_setup.failed', {
      reason: e instanceof FileStorageError ? e.message : e instanceof Error ? e.name : 'NonError',
    });
    return 1;
  }
}

/**
 * `grimoire db-setup`: makes a managed database ready for `grimoire migrate` (the two roles with their passwords, the schemas, citext), as the
 * database administrator, before the first migration and again whenever a password is rotated. Safe to run again. Prints which roles it made, never a password.
 */
async function dbSetup(): Promise<number> {
  const composed = composeDbSetup();
  if (!composed.ok) return composed.code;
  const { db, passwords, log } = composed.ctx;
  try {
    const result = await runDbSetup(db, passwords);
    log.info('db_setup.done', { created: result.created, updated: result.updated });
    return 0;
  } catch (e) {
    log.error('db_setup.failed', { error: e instanceof Error ? e.message : 'unknown error' });
    return 1;
  } finally {
    await db.close().catch(() => undefined);
  }
}

/**
 * `grimoire tenant-adopt --from <id> --to <id> [--name <name> --domain <domain>]`: moves the whole `from` workspace into the `to` tenant in one transaction, as the
 * migrator (docs/tenancy.md section 5, item 4). Prints the rows moved in each table, or the reason it changed nothing; never a name, a domain or a person.
 */
async function tenantAdopt(args: string[]): Promise<number> {
  const request = parseTenantAdoptArgs(args);
  if (request === undefined) {
    process.stderr.write(`${TENANT_ADOPT_USAGE}\n`);
    return 2;
  }
  const composed = composeTenantAdopt();
  if (!composed.ok) return composed.code;
  const { db, log } = composed.ctx;
  try {
    const result = await runTenantAdopt(db, request);
    if (result.kind === 'refused') {
      log.error('tenant_adopt.refused', { reason: result.reason });
      return 1;
    }
    log.info('tenant_adopt.done', { from: request.from, to: request.to, tenantCreated: result.tenantCreated, moved: result.moved, sourceTenantRow: 'kept' });
    return 0;
  } catch (e) {
    log.error('tenant_adopt.failed', { error: e instanceof Error ? e.message : 'unknown error' });
    return 1;
  } finally {
    await db.close().catch(() => undefined);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'migrate') {
  process.exitCode = await migrate(rest);
} else if (command === 'seed') {
  process.exitCode = await seed();
} else if (command === 'files-setup') {
  process.exitCode = await filesSetup();
} else if (command === 'db-setup') {
  process.exitCode = await dbSetup();
} else if (command === 'tenant-adopt') {
  process.exitCode = await tenantAdopt(rest);
} else {
  process.stderr.write(
    'usage: grimoire migrate [--dir <migrations directory>] | grimoire seed | grimoire files-setup | grimoire db-setup | grimoire tenant-adopt --from <tenant id> --to <tenant id> [--name <name> --domain <domain>]\n',
  );
  process.exitCode = 2;
}
