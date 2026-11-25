import { Hono } from 'hono';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { Database } from '@tektum/grimoire-core/ports/database';
import type { EventLog } from '../events.js';

export interface HealthDeps {
  readonly db: Database;
  readonly log: EventLog;
  /** Time for the probe caches; tests move it without timers. */
  readonly clock: Clock;
  readonly isDraining: () => boolean;
  /** Name (without extension) of the newest migration this server ships; the database must have applied it. */
  readonly expectedMigration: string;
  /** How long a readiness probe waits for the database before answering 503. */
  readonly probeTimeoutMs?: number;
  /** The state of the job queue for a role that runs jobs; `/readyz` reports it in `X-Grimoire-Jobs` and stays 200 (the API still serves). */
  readonly jobs?: () => string;
}

/**
 * The runtime role cannot read `kysely_migration`, so migration 0003 gives it this function (security definer, the latest applied name).
 * A database without it is a database that has not been migrated to this server's version.
 */
const VERSION_SQL = 'select grimoire_schema_version() as version';
/** A successful probe is trusted this long: readiness follows the database within a few seconds without a query per probe. */
const READY_CACHE_MS = 2000;
/** A failed probe is trusted this long too: a database that is down or hung is not asked again by every probe, so probes cannot pile up behind it. */
const FAILED_CACHE_MS = 1000;

type Outcome = 'ready' | 'migration_pending' | 'database';

export function healthRoutes(deps: HealthDeps): Hono {
  const probeTimeoutMs = deps.probeTimeoutMs ?? 2000;
  let readyUntil = 0;
  let failedUntil = 0;
  let failure: Outcome = 'database';
  /** The probe in flight, shared by concurrent requests: five probes at once are one database check. */
  let inflight: Promise<Outcome> | undefined;

  const check = async (): Promise<void> => {
    await deps.db.ping();
    let version: string | null | undefined;
    try {
      version = (await deps.db.query<{ version: string | null }>(VERSION_SQL))[0]?.version;
    } catch {
      throw new MigrationsPending(); // the function is missing (undefined function) or the schema is gone
    }
    if (typeof version !== 'string' || version < deps.expectedMigration) throw new MigrationsPending();
  };

  /**
   * The database check in progress. A probe that timed out leaves its queries running in the pool; the next probe joins that same check instead of
   * starting another, so a database that accepts connections and never answers costs one connection, not one more every few seconds.
   */
  let running: Promise<void> | undefined;
  const startCheck = (): Promise<void> => {
    running ??= check().finally(() => { running = undefined; });
    return running;
  };

  // Hand-written: a hung pool must not hang the probe, and Hono's timeout middleware is too coarse (seconds) for a probe.
  const checkWithTimeout = async (): Promise<Outcome> => {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('probe timeout')); }, probeTimeoutMs); });
    try {
      await Promise.race([startCheck(), limit]);
      readyUntil = deps.clock.now() + READY_CACHE_MS;
      return 'ready';
    } catch (e) {
      failure = e instanceof MigrationsPending ? 'migration_pending' : 'database';
      failedUntil = deps.clock.now() + FAILED_CACHE_MS;
      return failure;
    } finally {
      clearTimeout(timer);
    }
  };

  const probe = (): Promise<Outcome> => {
    const now = deps.clock.now();
    if (now < readyUntil) return Promise.resolve('ready');
    if (now < failedUntil) return Promise.resolve(failure);
    inflight ??= checkWithTimeout().finally(() => { inflight = undefined; });
    return inflight;
  };

  const app = new Hono();
  app.get('/healthz', (c) => c.text('ok'));
  app.get('/readyz', async (c) => {
    if (deps.isDraining()) { deps.log.debug('health.not_ready', { reason: 'draining' }); return c.text('unavailable', 503); }
    const outcome = await probe();
    if (outcome !== 'ready') { deps.log.debug('health.not_ready', { reason: outcome }); return c.text('unavailable', 503); }
    if (deps.jobs !== undefined) c.header('x-grimoire-jobs', deps.jobs());
    return c.text('ok');
  });
  return app;
}
class MigrationsPending extends Error {}
