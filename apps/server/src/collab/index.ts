import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { CollabDeps, CollaborationHost } from '@tektum/grimoire-core/ports/collaboration-host';
import type { Config } from '@tektum/grimoire-core/ports/config';
import { errorName } from '../events.js';
import type { EventLog } from '../events.js';
import type { Shutdown, ShutdownHook } from '../lifecycle/shutdown.js';
import { SHUTDOWN_BUDGET_MS } from '../lifecycle/budget.js';

/** The one path the collaboration host serves (R2.41). */
export const COLLAB_PATH = '/collab';

export interface StartCollabDeps {
  readonly config: Config;
  readonly log: EventLog;
  readonly host: CollaborationHost;
  /** What the host needs; built by the composition root. */
  readonly hostDeps: CollabDeps;
  /** The shared HTTP server the collaboration host attaches its upgrade listener to (R2.21). */
  readonly server: Server;
  readonly shutdown: Shutdown;
}

type Handler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

function respond(socket: Duplex, status: 400 | 404 | 503): void {
  const text = { 400: 'Bad Request', 404: 'Not Found', 503: 'Service Unavailable' }[status];
  // Node removes its own error listener before it emits 'upgrade': without one, a client that resets the connection while the answer is written would be an
  // uncaught exception (ECONNRESET/EPIPE) that takes the process down.
  socket.on('error', () => undefined);
  socket.end(`HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** One `collab.upgrade_error` per 10 s: a flood of bad requests must not flood the log. */
function throttledUpgradeError(log: EventLog, now: () => number = Date.now): (reason: 'malformed-target' | 'handler-error', e: unknown) => void {
  let last = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  return (reason, e) => {
    if (now() - last < 10_000) { suppressed += 1; return; }
    last = now();
    log.warn('collab.upgrade_error', { reason, errorName: errorName(e), suppressed });
    suppressed = 0;
  };
}

/**
 * The one boundary every upgrade listener goes through: whatever the handler throws is logged (throttled, fixed reason, error class
 * only) and the socket is destroyed, so a request can never become an uncaught exception.
 */
function guarded(log: EventLog, handler: Handler): Handler {
  const report = throttledUpgradeError(log);
  return (req, socket, head) => {
    try {
      handler(req, socket, head);
    } catch (e) {
      report('handler-error', e);
      socket.destroy();
    }
  };
}

/** Roles without the collaboration host, and the main port when a second port serves it: every upgrade is a 404. */
export function rejectUpgrades(server: Server, log: EventLog): void {
  server.on('upgrade', guarded(log, (_req, socket) => { respond(socket, 404); }));
}

/** Routes `/collab` to the host, anything else is a 404, a malformed request target a 400, and a draining server answers 503. */
function route(host: CollaborationHost, shutdown: Shutdown, log: EventLog): Handler {
  const report = throttledUpgradeError(log);
  return guarded(log, (req, socket, head) => {
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://collab.invalid').pathname;
    } catch (e) {
      report('malformed-target', e);
      respond(socket, 400);
      return;
    }
    if (path !== COLLAB_PATH) respond(socket, 404);
    else if (shutdown.isDraining()) respond(socket, 503);
    else host.handleUpgrade(req, socket, head);
  });
}

/** Collaboration hooks are constructed here, registered by lifecycle/run.ts in one place (S7/N6). */
export function collabShutdownHooks(config: Config, host: CollaborationHost, second?: Server): readonly ShutdownHook[] {
  return [
    { name: 'collab-stop-accepting', phase: 'stop-accepting', deadlineMs: SHUTDOWN_BUDGET_MS.collabStopAccepting,
      async run() {
        // The host's sockets first: a socket handed off by 'upgrade' is no longer tracked by the HTTP server (closeAllConnections does not reach it), yet
        // `close()` waits for every open socket, so waiting for the listener before closing them would always run into the hook's deadline.
        await host.closeConnections();
        if (second) { const listener = second; listener.closeAllConnections(); await new Promise<void>((resolve) => { listener.close(() => { resolve(); }); }); }
      } },
    { name: 'collab-save-pages', phase: 'save-pages', deadlineMs: config.shutdownSaveDeadlineMs + SHUTDOWN_BUDGET_MS.saveLead,
      async run() {
        const report = await host.shutdown({ deadlineMs: config.shutdownSaveDeadlineMs });
        if (report.abandonedPages > 0) throw new Error('pages left unsaved');
      } },
  ];
}

/** Starts the host and attaches it to the HTTP server (or a second port when configured). Failure closes a host already started. */
export async function startCollab(deps: StartCollabDeps): Promise<readonly ShutdownHook[]> {
  const { config, log, host, server, shutdown } = deps;
  await host.start(deps.hostDeps);
  const handler = route(host, shutdown, log);
  let second: Server | undefined;
  const abort = async (): Promise<void> => {
    second?.closeAllConnections();
    if (second) { const listener = second; await new Promise<void>((resolve) => { listener.close(() => { resolve(); }); }); }
    await host.shutdown({ deadlineMs: config.shutdownSaveDeadlineMs });
  };
  if (config.collabPort === undefined) server.on('upgrade', handler);
  else {
    rejectUpgrades(server, log);
    const s = createServer((_req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); });
    s.on('upgrade', handler);
    try { await new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(config.collabPort, config.host, () => { s.off('error', reject); resolve(); }); }); }
    catch (e) { second = s; await abort(); throw e; }
    second = s;
    log.info('collab.listening', { host: config.host, port: config.collabPort });
  }
  if (shutdown.isDraining()) {
    if (config.collabPort === undefined) server.off('upgrade', handler);
    await abort();
    return [];
  }
  const secondListener = second;
  const hooks = collabShutdownHooks(config, host, secondListener);
  log.info('collab.attached', { role: config.role });
  return hooks;
}
