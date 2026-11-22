import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Hocuspocus } from '@hocuspocus/server';
import type { Extension } from '@hocuspocus/server';
import type { CollaborationHost, CollabDeps, ShutdownReport } from '@tektum/grimoire-core/ports/collaboration-host';
import crossws from 'crossws/adapters/node';
import { readContext } from './context.js';
import { createCollabLog } from './events.js';
import { throttleLog } from './log-throttle.js';
import { createLifecycle } from './extensions/lifecycle.js';
import { createPeerHooks } from './peer-bridge.js';
import { PeerRegistry } from './peers.js';
import type { BreakerOptions } from './save.js';
import { buildExtensions } from './registry.js';
import { GOING_AWAY, REFUSAL_CLOSE_CODES } from './refusal.js';
import type { RefusalTable } from './refusal.js';
import { createUpgradeGuard } from './upgrade-guard.js';
import type { UpgradeGuard } from './upgrade-guard.js';

export interface CollabHostOptions {
  /** Waits `ms`; the store retry backoff. Tests replace it to run on a fake clock. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Extra extensions, e.g. a probe in tests. */
  readonly extensions?: readonly Extension[];
  /** Called after every document change (next milestone). Must not throw. */
  readonly onChange?: (e: { documentName: string }) => void;
  /** Breaker settings of the save path; the server sets only the test-only `disabled` switch, and only in local mode. */
  readonly breaker?: BreakerOptions;
  /** Hocuspocus idle timeout (default 60 000 ms) and crossws ping interval (default 30 s): tests shorten them. */
  readonly idleTimeoutMs?: number;
  readonly pingIntervalSeconds?: number;
  readonly guard?: UpgradeGuard;
  /** Extra refusal reasons with their close codes, merged over `REFUSAL_CLOSE_CODES`; an extension throws `new Refusal(reason)`. */
  readonly refusals?: RefusalTable;
  /** Heap bytes in use for the memory guard (default: V8's `used_heap_size`); tests inject a value. */
  readonly memoryUsed?: () => number;
}

export interface HocuspocusCollabHost extends CollaborationHost {
  /** The running Hocuspocus instance, for tests and diagnostics; undefined before `start`. */
  readonly hocuspocus: Hocuspocus | undefined;
}

function reject(socket: Duplex, status: 403 | 404 | 429 | 503, retryAfterSeconds?: number): void {
  if (socket.destroyed) return;
  socket.on('error', () => undefined); // after 'upgrade' Node no longer listens: a client reset while the answer is written must not be an uncaught exception
  const text = { 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 503: 'Service Unavailable' }[status];
  socket.end(`HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\n${retryAfterSeconds === undefined ? '' : `Retry-After: ${String(retryAfterSeconds)}\r\n`}Content-Length: 0\r\n\r\n`);
}

/** Node's header map as web `Headers` (repeated headers arrive as arrays). */
function toHeaders(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) h.append(name, v);
    else if (value !== undefined) h.set(name, value);
  }
  return h;
}

/** At most one report per 10 s, carrying how many were held back: a flood of failing upgrades must not flood the log. */
function throttled(report: (e: unknown, suppressed: number) => void): (e: unknown) => void {
  let last = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  return (e) => {
    if (Date.now() - last < 10_000) { suppressed += 1; return; }
    last = Date.now();
    report(e, suppressed);
    suppressed = 0;
  };
}

export function createCollabHost(options: CollabHostOptions = {}): HocuspocusCollabHost {
  let guard: UpgradeGuard = options.guard ?? createUpgradeGuard();
  const peers = new PeerRegistry({ ...REFUSAL_CLOSE_CODES, ...options.refusals });
  let hocuspocus: Hocuspocus | undefined;
  let ws: ReturnType<typeof crossws> | undefined;
  let persistenceAbandon: (() => void) | undefined;
  let persistenceUnsaved: () => string[] = () => [];
  let persistenceBeginShutdown: (() => void) | undefined;
  let saveAll: ReturnType<typeof createLifecycle>['saveAll'] | undefined;
  let stopRecheck: (() => void) | undefined;
  let accepting = false;
  let reportUpgradeFailure: (e: unknown) => void = () => undefined; // set in start(), where the log exists

  /** One page: only that page's document connections (the sockets stay, other pages on them keep working). One user: exactly that user's documents on every socket. Neither: everything. */
  const closeSockets = (filter?: { userId?: string; documentName?: string }): Promise<void> => {
    if (filter?.documentName !== undefined) hocuspocus?.closeConnections(filter.documentName);
    else if (filter?.userId !== undefined) {
      peers.closeUser(filter.userId, (peerId, documentName) => {
        for (const c of hocuspocus?.documents.get(documentName)?.getConnections() ?? []) {
          if (readContext(c.context).peerId === peerId) c.close({ code: GOING_AWAY.code, reason: GOING_AWAY.reason });
        }
      });
    }
    // Sockets only: the client then sees the 1001 close itself (Hocuspocus's own per-document close reaches the provider as code 1000),
    // and Hocuspocus closes and stores the documents when each socket closes.
    else peers.closeAll();
    return Promise.resolve();
  };

  return {
    get hocuspocus() { return hocuspocus; },

    start(deps: CollabDeps): Promise<void> {
      const log = throttleLog(createCollabLog(deps.logger)); // a flood must not fill the log: see log-throttle.ts
      const lifecycle = createLifecycle(log);
      reportUpgradeFailure = throttled((e, suppressed) => { log.emit('collab.upgrade_failed', { errorName: e instanceof Error ? e.name : 'NonError', suppressed }); });
      if (!options.guard) {
        const c = deps.config;
        guard = createUpgradeGuard({
          allowedOrigins: c.allowedOrigins, trustedProxies: c.trustedProxies, log,
          attemptsPerWindow: c.collab.connectAttemptsPerWindow, windowSeconds: c.collab.connectWindowSeconds,
          banSeconds: c.collab.banSeconds, maxUnauthSocketsPerAddress: c.collab.maxUnauthSocketsPerAddress,
          maxUnauthSockets: c.collab.maxUnauthSockets, maxUnauthQueuedBytes: c.collab.maxUnauthQueuedBytes, stats: (openUnauthenticated) => { log.emit('server.stats', { openUnauthenticated }); }, unauthTimeoutMs: c.collab.preauthTimeoutSeconds * 1000,
        });
      }
      const { extensions, persistence, recheck } = buildExtensions({
        deps, log, peers, guard,
        sleep: options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal })),
        ...(options.onChange ? { onChange: options.onChange } : {}),
        ...(options.extensions ? { extra: options.extensions } : {}),
        ...(options.memoryUsed ? { memoryUsed: options.memoryUsed } : {}),
        ...(options.breaker ? { breaker: options.breaker } : {}),
      });
      const hp = new Hocuspocus({
        debounce: deps.config.collab.debounceMs,
        maxDebounce: deps.config.collab.maxDebounceMs,
        quiet: true,
        // What a socket may have queued before it authenticates: honest clients send only their auth frame (their offline backlog follows the first server message), so one maximum frame is enough.
        maxUnauthenticatedQueueSize: 1024 * 1024,
        ...(options.idleTimeoutMs !== undefined ? { timeout: options.idleTimeoutMs } : {}),
        extensions: [...extensions, lifecycle.extension],
      });
      lifecycle.bind(hp);
      hocuspocus = hp;
      persistenceAbandon = () => { persistence.abandon(); };
      persistenceUnsaved = () => persistence.unsavedPages();
      persistenceBeginShutdown = () => { persistence.beginShutdown(); };
      saveAll = lifecycle.saveAll;
      stopRecheck = () => { recheck.stop(); };
      ws = crossws({
        serverOptions: { maxPayload: deps.config.collab.maxPayloadBytes },
        ...(options.pingIntervalSeconds !== undefined ? { idleTimeout: options.pingIntervalSeconds } : {}),
        hooks: createPeerHooks({
          hocuspocus: hp, peers, guard,
          onFrameTooLarge: () => { log.emit('collab.limit_hit', { limit: 'message-size', value: deps.config.collab.maxPayloadBytes + 1, max: deps.config.collab.maxPayloadBytes }); },
        }),
      });
      accepting = true;
      return Promise.resolve();
    },

    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
      if (!accepting || !ws) { reject(socket, 503); return; }
      const upgrade = ws;
      guard.checkUpgrade(req, socket).then((verdict) => {
        if (!verdict.ok) { reject(socket, verdict.status, verdict.retryAfterSeconds); return; }
        if (!accepting) { reject(socket, 503); return; } // shutdown began while the verdict was pending: no new socket after the final save
        // crossws puts `context` of the request it is given on the peer: that is how the reservation of THIS socket reaches `open`.
        const web = Object.assign(new Request(new URL(req.url ?? '/', 'http://collab.invalid'), { headers: toHeaders(req) }), { context: { ticket: verdict.ticket } });
        return upgrade.handleUpgrade(req, socket, head, web);
      }).catch((e: unknown) => {
        reportUpgradeFailure(e);
        socket.destroy();
      });
    },

    closeConnections: closeSockets,

    async shutdown({ deadlineMs }: { deadlineMs: number }): Promise<ShutdownReport> {
      accepting = false;
      stopRecheck?.(); // no round runs after this: the sockets are about to close and the timer must not outlive the host
      persistenceBeginShutdown?.(); // no more "convert later" timers: the final saves below convert now or store the state alone
      await closeSockets();
      const report = saveAll && persistenceAbandon
        ? await saveAll({ deadlineMs, abandon: persistenceAbandon, unsaved: persistenceUnsaved })
        : { abandonedPages: 0 };
      await ws?.close(GOING_AWAY.code, GOING_AWAY.reason);
      return report;
    },
  };
}
