import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '@tektum/grimoire-core/ports/database';
import { eventually as waitEventually } from './e2e.ts';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const serverDir = path.join(repoRoot, 'apps/server');
export const mainJs = path.join(serverDir, 'dist/main.js');
export const hooksEntry = path.join(serverDir, 'test/server/support/hooks-entry.mjs');
export const slowEntry = path.join(serverDir, 'test/server/support/slow-route-entry.mjs');
const HOST = '127.0.0.1:55432';
export const adminUrl = (db: string): string => `postgresql://grimoire_admin:grimoire-dev@${HOST}/${db}`;
export const appUrl = (db: string): string => `postgresql://grimoire_app:grimoire-dev@${HOST}/${db}`;
export const migratorUrl = (db: string): string => `postgresql://grimoire_migrator:grimoire-dev@${HOST}/${db}`;
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
export function runToEnd(args: string[], env: Record<string, string>): Promise<Exit> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: baseEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code, signal) => { resolve({ code, signal, output }); });
  });
}

export class ServerProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<Exit>;
  private out = '';
  readonly port: number;
  constructor(args: string[], env: Record<string, string>, port: number) {
    this.port = port;
    this.child = spawn(process.execPath, args, { env: baseEnv({ GRIMOIRE_HOST: '127.0.0.1', GRIMOIRE_PORT: String(port), ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout?.on('data', (data: Buffer) => { this.out += data.toString(); });
    this.child.stderr?.on('data', (data: Buffer) => { this.out += data.toString(); });
    this.exited = new Promise<Exit>((resolve) => {
      this.child.on('close', (code, signal) => { resolve({ code, signal, output: this.out }); });
    });
  }
  get output(): string { return this.out; }
  get events(): LogEvent[] {
    // `out` mixes stdout and stderr and may end in a half-written line: only complete JSON lines are events.
    return this.out.split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as LogEvent]; } catch { return []; }
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
