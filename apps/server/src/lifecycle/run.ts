import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { getRequestListener } from '@hono/node-server';
import type { Hono } from 'hono';
import type { AppEnv } from '../http/env.js';
import { createApp } from '../app.js';
import { rejectUpgrades, startCollab } from '../collab/index.js';
import type { StartCollabDeps } from '../collab/index.js';
import { compose } from '../composition.js';
import type { AppContext, Composition } from '../composition.js';
import { errorName } from '../events.js';
import type { EventLog } from '../events.js';
import { routeConsoleToEvents } from './console.js';
import { DERIVED_BUDGETS_MS, SHUTDOWN_BUDGET_MS, overallShutdownDeadlineMs } from './budget.js';
import { EXIT, installProcessHandlers, processSignals } from './process.js';
import type { SignalSource } from './process.js';

/** After draining starts the listener stays open this long so a probe can see /readyz 503 before connections are refused (R2.42). */
export const DRAIN_PROPAGATION_MS = SHUTDOWN_BUDGET_MS.drainPropagation;
/** In-flight requests get this long to finish after the listener closes; then their sockets are closed. */
export const HTTP_DRAIN_MS = SHUTDOWN_BUDGET_MS.httpDrain;
export const POOL_CLOSE_MS = DERIVED_BUDGETS_MS.poolClose;
const isLoopback = (host: string): boolean => host === '::1' || host.startsWith('127.') || host.toLowerCase().startsWith('::ffff:127.');

export interface RunOptions {
  readonly routes?: (app: Hono<AppEnv>, ctx: AppContext) => void;
  readonly env?: Parameters<typeof compose>[0];
  readonly compose?: () => Composition;
  readonly source?: SignalSource;
  readonly exit?: (code: number) => void;
}

/** Test seam: construct the real run and observe its event log; composition alone has no global effect. */
export type CollabStarter = (deps: StartCollabDeps) => ReturnType<typeof startCollab>;
export interface RunHarness { (): Promise<void>; readonly logger: EventLog }

/** Every shutdown hook is registered here, before any await during startup (S7/S8). */
export function createRun(options: RunOptions = {}, collabStarter: CollabStarter = startCollab): RunHarness {
  let runningLogger: EventLog | undefined;
  const call = async (): Promise<void> => {
    const composed = options.compose ? options.compose() : compose(options.env);
    if (!composed.ok) {
      if (composed.refused) {
        // Valid settings, but a test double was wired outside local mode: refuse to start.
        composed.log.error('server.start_failed', { errorName: 'CompositionRefused', errorCode: composed.refused.reason, host: composed.refused.host, port: composed.refused.port });
        (options.exit ?? process.exit)(EXIT.failure);
        return;
      }
      composed.log.error('server.config_invalid', { settings: composed.problems });
      (options.exit ?? process.exit)(EXIT.config);
      return;
    }
    const { ctx } = composed;
    const { log, config } = ctx;
    runningLogger = log;
    installProcessHandlers({ shutdown: ctx.shutdown, log, source: options.source ?? processSignals, exit: options.exit ?? process.exit, overallDeadlineMs: overallShutdownDeadlineMs(config.shutdownSaveDeadlineMs, ctx.jobs === undefined ? 0 : config.jobs.stopGraceMs) });
    log.info('server.starting', { role: config.role, local: config.local });
    if (ctx.testFacilities.length > 0) log.warn('server.test_facilities_active', { facilities: ctx.testFacilities });
    routeConsoleToEvents(log);
    const app = createApp(ctx);
    options.routes?.(app, ctx);
    const server = createServer(getRequestListener(app.fetch, {
      overrideGlobalObjects: false,
      errorHandler: (e) => { log.error('http.request_failed', { errorName: errorName(e) }); return new Response('internal error', { status: 500, headers: { 'content-type': 'text/plain' } }); },
    }));
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    ctx.shutdown.register({
      name: 'http-server', phase: 'stop-accepting', deadlineMs: DERIVED_BUDGETS_MS.httpStopAccepting,
      async run() {
        if (!server.listening) return;
        await sleep(DRAIN_PROPAGATION_MS);
        const closed = new Promise<void>((resolve, reject) => { server.close((e) => { if (e) reject(e); else resolve(); }); });
        server.closeIdleConnections();
        const sweep = setInterval(() => { server.closeIdleConnections(); }, 100);
        const force = setTimeout(() => { server.closeAllConnections(); }, HTTP_DRAIN_MS);
        try { await closed; } finally { clearInterval(sweep); clearTimeout(force); }
      },
    });
    for (const hook of ctx.shutdownHooks) ctx.shutdown.register(hook);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
      });
      if (config.local && !isLoopback(config.host)) log.warn('server.local_mode_exposed', { host: config.host });
      if (ctx.collab) for (const hook of await collabStarter({ config, log, host: ctx.collab.host, hostDeps: ctx.collab.deps, server, shutdown: ctx.shutdown })) ctx.shutdown.register(hook);
      else rejectUpgrades(server, log);
      // Not awaited: a database that does not answer must not hold the server's start (the runner logs and retries; it never rejects).
      if (ctx.jobs) void ctx.jobs.start();
    } catch (e) {
      if (ctx.shutdown.isDraining()) return;
      const code = e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : 'none';
      log.error('server.start_failed', { errorName: errorName(e), errorCode: code, host: config.host, port: config.port });
      await ctx.shutdown.runStartupFailure(log);
      exitAfterStartFailure(options);
      return;
    }
    if (ctx.shutdown.isDraining()) return;
    log.info('http.listening', { host: config.host, port: config.port });
  };
  Object.defineProperty(call, 'logger', { get: (): EventLog => { if (!runningLogger) throw new Error('logger requested before composition'); return runningLogger; } });
  return call as RunHarness;
}

function exitAfterStartFailure(options: RunOptions): void {
  (options.exit ?? process.exit)(EXIT.failure);
}
export const run = (options: RunOptions = {}): Promise<void> => createRun(options)();
