#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { composeSeed } from './composition.js';
import { composeMigrate } from './lifecycle/compose-migrate.js';
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
    const { applied } = await composed.migrate(values.dir ?? defaultDir);
    if (applied.length === 0) log.info('migrate.nothing_pending', {});
    for (const name of applied) log.info('migrate.applied', { migration: name });
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

const [command, ...rest] = process.argv.slice(2);
if (command === 'migrate') {
  process.exitCode = await migrate(rest);
} else if (command === 'seed') {
  process.exitCode = await seed();
} else {
  process.stderr.write('usage: grimoire migrate [--dir <migrations directory>] | grimoire seed\n');
  process.exitCode = 2;
}
