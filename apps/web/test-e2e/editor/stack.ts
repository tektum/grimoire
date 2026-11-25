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
  const began = Date.now();
  let phase = 'compose up';
  const reportStall = (): void => void stackReport().then((report) => console.log(`recreateApp: still in ${phase} after ${seconds(STALL_REPORT_MS)}\n${report}`));
  // A watchdog, not a wait (allow-listed in tools/ci/test-sleep-allow.json): it describes the stack once while the recreate is still going, because a spec cut
  // off by its own timeout never reaches the lines after the await, and a stall is the thing to see.
  const stalled = setTimeout(reportStall, STALL_REPORT_MS);
  try {
    await run('docker', ['compose', '-p', 'grimoire', 'up', '-d', '--no-deps', '--force-recreate', 'app'], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
      env: recreateEnv(settings),
    });
    const upMs = Date.now() - began;
    console.log(`recreateApp: compose up ${seconds(upMs)}`);
    phase = '/readyz';
    try {
      await waitReady();
    } catch (error) {
      console.log(`recreateApp: compose up ${seconds(upMs)}, then /readyz never answered (${seconds(Date.now() - began - upMs)})\n${await stackReport()}`);
      throw error;
    }
    console.log(`recreateApp: compose up ${seconds(upMs)}, /readyz ${seconds(Date.now() - began - upMs)}`);
  } finally {
    clearTimeout(stalled);
  }
}

/** A recreate still going after this is described in the output: it is the stall that cost three specs and about seven minutes of a browser run twice (a normal one takes a few seconds). */
const STALL_REPORT_MS = 45_000;
/** Each line of the report is cut here; the lines themselves are all kept. */
const REPORT_LINE_CHARS = 500;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** What the stack looks like now (containers and the last 25 lines of the app's log), for a recreate that stalled or failed; never throws, and each command has 15 s (a hung Docker must not hold the report). */
async function stackReport(): Promise<string> {
  const part = async (label: string, args: string[]): Promise<string> => {
    try {
      const { stdout } = await run('docker', ['compose', '-p', 'grimoire', ...args], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 });
      const lines = stdout.trim().split('\n').map((line) => (line.length > REPORT_LINE_CHARS ? `${line.slice(0, REPORT_LINE_CHARS)}...` : line));
      return `--- ${label}\n${lines.join('\n')}`;
    } catch (error) {
      return `--- ${label}: ${error instanceof Error ? error.message.slice(0, 200) : 'failed'}`;
    }
  };
  return [await part('docker compose ps', ['ps', '--all']), await part('app log, last lines', ['logs', '--no-log-prefix', '--tail', '25', 'app'])].join('\n');
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
