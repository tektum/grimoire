import { PgBoss, type ConstructorOptions, type JobWithMetadata } from 'pg-boss';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import { expirySignalDelayMs, type EnqueueOptions, type JobHandler, type JobQueue, type QueueDefinition } from '@tektum/grimoire-core/ports/job-queue';

/** The schema pg-boss keeps its tables in; the Kysely migrations never touch it. */
export const PGBOSS_SCHEMA = 'pgboss';

/** Stop waits this long for running jobs by default; the server checks that it fits the release step of the shutdown budget. */
export const DEFAULT_STOP_GRACE_MS = 1500;

/** The part of pg-boss the adapter uses; tests pass a stand-in. */
export type PgBossLike = Pick<PgBoss, 'start' | 'stop' | 'send' | 'work' | 'schedule' | 'createQueue' | 'getQueue' | 'findJobs' | 'isInstalled' | 'on'>;

/** The database object pg-boss accepts for one call (`db` option). */
interface PgBossDatabase { executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }

/** Hands a Kysely transaction (or any Queryable) to pg-boss as its database for one call. */
function asDatabase(tx: Queryable): PgBossDatabase {
  return { executeSql: async (text: string, values?: unknown[]) => ({ rows: [...(await tx.query(text, values))] }) };
}

export class PgBossJobQueue implements JobQueue {
  /** The abort controllers of the handlers that are running now. */
  private readonly running = new Set<AbortController>();

  constructor(
    private readonly boss: PgBossLike,
    private readonly stopGraceMs: number = DEFAULT_STOP_GRACE_MS,
  ) {}

  /** Creates the queue unless it exists. Run it with a role that may create tables (`grimoire migrate`), before `work`, `schedule` or `enqueue` use the name. */
  async ensureQueue(definition: QueueDefinition): Promise<void> {
    if (await this.boss.getQueue(definition.name)) return;
    await this.boss.createQueue(definition.name, {
      policy: definition.policy,
      retryLimit: definition.retryLimit,
      retryDelay: definition.retryDelaySeconds,
      retryBackoff: definition.retryBackoff,
      expireInSeconds: definition.expireInSeconds,
      retentionSeconds: definition.retentionSeconds,
      ...(definition.deadLetter === undefined ? {} : { deadLetter: definition.deadLetter }),
    });
  }

  async enqueue<Payload>(name: string, payload: Payload, options: EnqueueOptions = {}, tx?: Queryable): Promise<string | null> {
    const id = await this.boss.send(name, payload as object, {
      ...(options.delaySeconds === undefined ? {} : { startAfter: options.delaySeconds }),
      ...(options.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
      ...(options.retryLimit === undefined ? {} : { retryLimit: options.retryLimit }),
      ...(options.expireInSeconds === undefined ? {} : { expireInSeconds: options.expireInSeconds }),
      ...(tx ? { db: asDatabase(tx) } : {}),
    });
    if (id !== null || options.singletonKey === undefined) return id;
    // pg-boss answers null when the key is taken; the port answers with the job that holds it.
    const [existing] = await this.boss.findJobs(name, { key: options.singletonKey, queued: true, limit: 1 });
    return existing?.id ?? null;
  }

  async isLive(name: string, singletonKey: string): Promise<boolean> {
    const jobs = await this.boss.findJobs(name, { key: singletonKey, limit: 100_000 });
    return jobs.some((j) => j.state === 'created' || j.state === 'retry' || j.state === 'active');
  }

  async work<Payload>(name: string, handler: JobHandler<Payload>): Promise<void> {
    await this.boss.work<Payload, void, { includeMetadata: true }>(name, { includeMetadata: true }, async (jobs: JobWithMetadata<Payload>[]) => {
      for (const job of jobs) {
        const own = new AbortController();
        this.running.add(own);
        const timer = setTimeout(() => { own.abort(); }, expirySignalDelayMs(job.expireInSeconds));
        try {
          const signal = job.signal ? AbortSignal.any([own.signal, job.signal]) : own.signal;
          await handler(job.data, { jobId: job.id, attempt: job.retryCount + 1, retryLimit: job.retryLimit, signal });
        } finally {
          clearTimeout(timer);
          this.running.delete(own);
        }
      }
    });
  }

  async schedule(name: string, cron: string, payload?: unknown): Promise<void> {
    await this.boss.schedule(name, cron, (payload ?? null) as object | null, { tz: 'UTC' });
  }

  /** True when pg-boss's tables are installed and answer; false otherwise (for the readiness check). */
  async isReady(): Promise<boolean> {
    try {
      return await this.boss.isInstalled();
    } catch {
      return false;
    }
  }

  /** Stops fetching, waits up to `graceMs` for running jobs (aborting their signals at `graceMs - 2000`), then closes pg-boss's connections. */
  async stop({ graceMs = this.stopGraceMs }: { graceMs?: number } = {}): Promise<{ inFlight: number }> {
    const abortTimer = setTimeout(() => { for (const c of this.running) c.abort(); }, Math.max(0, graceMs - 2000));
    try {
      await this.boss.stop({ graceful: true, close: true, timeout: graceMs });
    } finally {
      clearTimeout(abortTimer);
    }
    return { inFlight: this.running.size };
  }
}

export interface CreateOptions {
  /** A connection string of a role that can use the pgboss schema. */
  readonly connectionString: string;
  readonly max?: number;
  /** Receives errors pg-boss reports from its background loops. Required: an unhandled `error` event would end the process. */
  readonly onError: (error: Error) => void;
  /** How long `stop` waits for running jobs unless it is told otherwise. Default 1.5 s. */
  readonly stopGraceMs?: number;
  /**
   * Run pg-boss's cron loop in this process, so `schedule` entries fire. Off by default: the loop calls `create_queue` for
   * an internal queue every time it starts, which the runtime role may not run. A process that is meant to fire schedules
   * needs a role that may.
   */
  readonly cron?: boolean;
}

/** pg-boss never migrates here (`migrate: false`): `grimoire migrate` owns the schema. Resolves once started. */
export async function createJobQueue(
  options: CreateOptions,
  make: (o: ConstructorOptions) => PgBossLike = (o) => new PgBoss(o),
): Promise<PgBossJobQueue> {
  const boss = make({
    connectionString: options.connectionString,
    schema: PGBOSS_SCHEMA,
    migrate: false,
    schedule: options.cron ?? false,
    ...(options.max === undefined ? {} : { max: options.max }),
  });
  boss.on('error', options.onError);
  await boss.start();
  return new PgBossJobQueue(boss, options.stopGraceMs);
}

export { grantRuntimeRole, migratePgBoss, type MigrateOptions } from './migrate.js';
