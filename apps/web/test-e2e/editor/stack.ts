import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import { apiUrl } from '../support/env';
import { repoRoot } from '../support/env';
import { storeOrigin } from '../attachments/real-stack';

const run = promisify(execFile);

/** Runs `docker compose` against the stack `make up` started (project name `grimoire`), from the repository root. */
export async function compose(...args: string[]): Promise<string> {
  const result = await run('docker', ['compose', '-p', 'grimoire', ...args], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return result.stdout;
}

/**
 * The environment `docker compose` recreates the app with: this process's, the web overlay, the address the browser reaches the file store at, and the settings given. The store address is
 * set by `make up` for the first start only, and a recreate that did not repeat it would sign every upload link for the store's in-network name, which a browser cannot reach: every
 * spec that uploads and runs after a recreate would fail (as the import specifications did).
 */
export function recreateEnv(settings: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, COMPOSE_FILE: 'compose.yaml:compose.m6.yaml', GRIMOIRE_S3_PUBLIC_ENDPOINT: process.env['GRIMOIRE_S3_PUBLIC_ENDPOINT'] ?? storeOrigin(), ...settings };
}

/**
 * Recreates the app with test settings of the web overlay (`compose.m6.yaml`: `M6_REQUIRE_HANDSHAKE`, `M6_MAX_CONNECTIONS_PER_PAGE`, `M6_RECHECK_SECONDS`,
 * `M6_MIN_CLIENT_VERSION`) and waits until it answers. With no settings it returns the app to the stack's defaults: a spec that changed them calls it in `finally`.
 */
export async function recreateApp(settings: Record<string, string> = {}): Promise<void> {
  await run('docker', ['compose', '-p', 'grimoire', 'up', '-d', '--no-deps', '--force-recreate', 'app'], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
    env: recreateEnv(settings),
  });
  await waitReady();
}

/** Waits for the app to answer `/readyz` again (after a restart or a start). */
export async function waitReady(): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${apiUrl()}/readyz`)).ok;
        } catch {
          return false;
        }
      },
      { timeout: 120_000, message: 'the app to answer /readyz' },
    )
    .toBe(true);
}

/** The JSON log lines the app wrote since `since`; other lines are ignored. */
export async function appEvents(since: Date): Promise<{ event: string; [key: string]: unknown }[]> {
  const out = await compose('logs', '--no-log-prefix', '--since', since.toISOString(), 'app');
  const events: { event: string; [key: string]: unknown }[] = [];
  for (const line of out.split('\n')) {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === 'object' && value !== null && 'event' in value && typeof value.event === 'string') events.push(value as { event: string });
    } catch {
      // not a JSON line
    }
  }
  return events;
}

/** Runs SQL as the administrator role inside the PostgreSQL container. */
export async function psqlAdmin(sql: string): Promise<void> {
  await compose('exec', '-T', 'postgres', 'psql', '-U', 'grimoire_admin', '-d', 'grimoire', '-v', 'ON_ERROR_STOP=1', '-c', sql);
}
