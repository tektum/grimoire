import { spawn } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '@tektum/grimoire-core/ports/database';
import { databaseUrl } from '@tektum/grimoire-core/testing/database-url';
import { eventually as waitEventually } from './e2e.ts';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const serverDir = path.join(repoRoot, 'apps/server');
export const mainJs = path.join(serverDir, 'dist/main.js');
export const hooksEntry = path.join(serverDir, 'test/server/support/hooks-entry.mjs');
export const slowEntry = path.join(serverDir, 'test/server/support/slow-route-entry.mjs');
export const HOST = '127.0.0.1:55432';
/** The password of the roles of the development database (the same in .env.example and compose.yaml: a published development value). The one place tests have it. */
const DEV_PASSWORD = 'grimoire-dev';
export const devDatabaseUrl = (role: 'grimoire_admin' | 'grimoire_app' | 'grimoire_migrator', db: string, host: string = HOST, password: string = DEV_PASSWORD): string => databaseUrl(role, password, host, db);
export const adminUrl = (db: string, host: string = HOST): string => devDatabaseUrl('grimoire_admin', db, host);
export const appUrl = (db: string, host: string = HOST): string => devDatabaseUrl('grimoire_app', db, host);
export const migratorUrl = (db: string, host: string = HOST): string => devDatabaseUrl('grimoire_migrator', db, host);
export function requireBuild(): void { if (!existsSync(mainJs)) throw new Error('apps/server/dist/main.js is missing: run `bun run build` first'); }

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') { server.close(); reject(new Error('Could not determine the free port')); return; }
      server.close(() => { resolve(address.port); });
    });
  });
}

export type DatabaseFactory = (url: string, options: { maxConnections: number }) => Database;
const dbName = (name: string): string => {
  if (!/^(?:grimoire_|postgres$)[a-z0-9_]*$/.test(name)) throw new Error(`Invalid test database name: ${name}`);
  return name;
};
export function createDatabaseSupport(create: DatabaseFactory) {
  async function sqlAdmin<R = unknown>(db: string, sql: string): Promise<readonly R[]> {
    const connection = create(adminUrl(dbName(db)), { maxConnections: 1 });
    try { return await connection.query<R>(sql); } finally { await connection.close(); }
  }
  return {
    sqlAdmin,
    async createTestDatabase(name: string, migrated: boolean): Promise<void> {
      const database = dbName(name);
      await sqlAdmin('postgres', `drop database if exists ${database} with (force)`);
      await sqlAdmin('postgres', `create database ${database} owner grimoire_migrator`);
      if (migrated) {
        const cli = await runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate'], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(database) });
        if (cli.code !== 0) throw new Error(`migrate failed: ${cli.output}`);
      }
    },
    dropTestDatabase: (name: string): Promise<readonly unknown[]> => sqlAdmin('postgres', `drop database if exists ${dbName(name)} with (force)`),
    async appConnections(db: string): Promise<number> {
      const rows = await sqlAdmin<{ n: string }>('postgres', `select count(*) as n from pg_stat_activity where datname = '${dbName(db)}' and usename = 'grimoire_app'`);
      return Number(rows[0]?.n);
    },
  };
}

export interface Exit { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly output: string }
export type LogEvent = Record<string, unknown>;
const baseEnv = (extra: Record<string, string>): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '', GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef', GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080', ...extra,
});
/** Preload that makes a child exit when its parent is gone: `node --import PARENT_WATCH ...` (every child the helpers start has it). */
export const PARENT_WATCH = path.resolve(import.meta.dirname, 'parent-watch.mjs');
const children = new Set<ChildProcess>();
// The parent leaving for any reason that runs exit handlers kills what it started, without a grace period (a test child holds no data worth a drain).
process.on('exit', () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
/** Starts a child that dies with this process: the parent's exit handler kills it, and PARENT_WATCH covers a parent that cannot run handlers (SIGKILL, crash). */
export function spawnWatched(args: readonly string[], env: Readonly<Record<string, string | undefined>>, stdio: StdioOptions = ['ignore', 'pipe', 'pipe']): ChildProcess {
  const child = spawn(process.execPath, ['--import', PARENT_WATCH, ...args], { env: { ...env, GRIMOIRE_TEST_PARENT_PID: String(process.pid) }, stdio });
  children.add(child);
  child.once('close', () => { children.delete(child); });
  return child;
}
export function runToEnd(args: string[], env: Record<string, string>): Promise<Exit> {
  return new Promise((resolve) => {
    const child = spawnWatched(args, baseEnv(env));
    let output = '';
    child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code, signal) => { resolve({ code, signal, output }); });
  });
}

/** Preload that reports the child's listeners at exit: `node --import TRACK_LISTENERS ...`, then `listenerReport(output)`. */
export const TRACK_LISTENERS = path.resolve(import.meta.dirname, 'track-listeners.mjs');
export interface ListenerReport { readonly started: number; readonly stillListening: number; readonly addresses: readonly string[] }
const MARKER = 'GRIMOIRE_TEST_LISTENERS ';
/** The newest listener report of the child (at exit, or after SIGUSR2); undefined when there is none (not preloaded, or killed). */
export function listenerReport(output: string): ListenerReport | undefined {
  const line = output.split('\n').filter((l) => l.startsWith(MARKER)).at(-1);
  return line === undefined ? undefined : (JSON.parse(line.slice(MARKER.length)) as ListenerReport);
}
/** The output without the report line. */
export const withoutListenerReport = (output: string): string => output.split('\n').filter((l) => !l.startsWith(MARKER)).join('\n');

export class ServerProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<Exit>;
  private out = '';
  readonly port: number;
  constructor(args: string[], env: Record<string, string>, port: number) {
    this.port = port;
    this.child = spawnWatched(args, baseEnv({ GRIMOIRE_HOST: '127.0.0.1', GRIMOIRE_PORT: String(port), ...env }));
    this.child.stdout?.on('data', (data: Buffer) => { this.out += data.toString(); });
    this.child.stderr?.on('data', (data: Buffer) => { this.out += data.toString(); });
    this.exited = new Promise<Exit>((resolve) => {
      this.child.on('close', (code, signal) => { resolve({ code, signal, output: this.out }); });
    });
  }
  get output(): string { return this.out; }
  get events(): LogEvent[] {
    // `out` mixes stdout and stderr. A trailing half-written line is not yet an event; a COMPLETE line that looks like JSON but does not parse is a
    // corrupted event (for example two streams interleaved mid-line) and fails loudly with the line, instead of silently vanishing.
    const lines = this.out.split('\n');
    lines.pop();
    return lines.filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as LogEvent]; } catch {
        if (line.trimStart().startsWith('{')) throw new Error(`unparsable JSON event line in the server output: ${line}`);
        return [];
      }
    });
  }
  get url(): string { return `http://127.0.0.1:${this.port}`; }
  signal(signal: NodeJS.Signals): void { this.child.kill(signal); }
  get alive(): boolean { return this.child.exitCode === null && this.child.signalCode === null; }
  async waitForEvent(event: string, timeoutMs = 10_000): Promise<void> {
    const seen = (): boolean => this.out.split('\n').some((line) => line.includes(`"event":"${event}"`));
    const exitedFirst = this.exited.then(() => { if (!seen()) throw new Error(`exited before ${event}`); });
    const condition = waitEventually(() => { if (seen()) return true; }, timeoutMs, event);
    condition.catch(() => undefined);
    await Promise.race([condition, exitedFirst]).catch((error: unknown) => {
      throw new Error(`timed out waiting for ${event}; output so far:\n${this.out}`, { cause: error });
    });
  }
  async kill(): Promise<void> { if (this.alive) this.child.kill('SIGKILL'); await this.exited; }
}
export interface StartOptions { readonly env?: Record<string, string>; readonly entry?: string; readonly nodeArgs?: string[] }
/** The product reports only its configured port, so retry up to five fresh OS-selected ports on EADDRINUSE. */
export async function startServer(options: StartOptions = {}): Promise<ServerProcess> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
    const server = new ServerProcess([...(options.nodeArgs ?? []), options.entry ?? mainJs], options.env ?? {}, port);
    try { await server.waitForEvent('http.listening'); return server; } catch (error: unknown) {
      await server.kill(); lastError = error;
      if (!server.output.includes('EADDRINUSE')) break;
    }
  }
  throw new Error('Test server did not start', { cause: lastError });
}
export async function get(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  return { status: response.status, body: await response.text() };
}
export function connectError(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', (error: NodeJS.ErrnoException) => { resolve(error.code ?? 'error'); });
  });
}
export { eventually, waitUntil } from './e2e.ts';
