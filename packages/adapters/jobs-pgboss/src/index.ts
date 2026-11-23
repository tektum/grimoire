import { PgBoss, type ConstructorOptions, type Job } from 'pg-boss';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import type { EnqueueOptions, JobHandler, JobQueue } from '@tektum/grimoire-core/ports/job-queue';

/** The schema pg-boss keeps its tables in; the Kysely migrations never touch it. */
export const PGBOSS_SCHEMA = 'pgboss';

/** Stop waits this long for running jobs by default; the server checks that it fits the release step of the shutdown budget. */
export const DEFAULT_STOP_GRACE_MS = 1500;

export interface EnsureQueueOptions {
  /** At most one queued or running job per `singletonKey` on this queue (the port's `singletonKey` option needs it). */
  readonly singleton?: boolean;
  /** A running job that reports nothing for this long is given back to the queue. */
  readonly expireInSeconds?: number;
}

/** The part of pg-boss the adapter uses; tests pass a stand-in. */
export type PgBossLike = Pick<PgBoss, 'start' | 'stop' | 'send' | 'work' | 'schedule' | 'createQueue' | 'getQueue' | 'isInstalled' | 'on'>;

/** The database object pg-boss accepts for one call (`db` option). */
interface PgBossDatabase { executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }

/** Hands a Kysely transaction (or any Queryable) to pg-boss as its database for one call. */
function asDatabase(tx: Queryable): PgBossDatabase {
  return { executeSql: async (text: string, values?: unknown[]) => ({ rows: [...(await tx.query(text, values))] }) };
}

export class PgBossJobQueue implements JobQueue {
  constructor(
    private readonly boss: PgBossLike,
    private readonly stopGraceMs: number = DEFAULT_STOP_GRACE_MS,
  ) {}

  /** Creates the queue unless it exists. Run it at start-up, before `work`, `schedule` or `enqueue` use the name. */
  async ensureQueue(name: string, options: EnsureQueueOptions = {}): Promise<void> {
    if (await this.boss.getQueue(name)) return;
    await this.boss.createQueue(name, {
      policy: options.singleton ? 'exclusive' : 'standard',
      ...(options.expireInSeconds === undefined ? {} : { expireInSeconds: options.expireInSeconds }),
    });
  }

  async enqueue<Payload>(name: string, payload: Payload, options: EnqueueOptions = {}, tx?: Queryable): Promise<string | null> {
    return this.boss.send(name, payload as object, {
      ...(options.delaySeconds === undefined ? {} : { startAfter: options.delaySeconds }),
      ...(options.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
      retryLimit: options.retryLimit ?? 0, // pg-boss would default to 2 retries; the port's default is none
      ...(tx ? { db: asDatabase(tx) } : {}),
    });
  }

  async work<Payload>(name: string, handler: JobHandler<Payload>): Promise<void> {
    await this.boss.work<Payload>(name, async (jobs: Job<Payload>[]) => {
      for (const job of jobs) await handler(job.data, { id: job.id, attempt: job.retryCount + 1 });
    });
  }

  async schedule(name: string, cron: string, payload?: unknown): Promise<void> {
    await this.boss.schedule(name, cron, (payload ?? null) as object | null, { tz: 'UTC' });
  }

  /** True when pg-boss's tables are installed and answer; false otherwise (for the readiness check). */
  async isLive(): Promise<boolean> {
    try {
      return await this.boss.isInstalled();
    } catch {
      return false;
    }
  }

  /** Stops fetching, waits up to `graceMs` for running jobs, then closes pg-boss's connections. */
  async stop({ graceMs = this.stopGraceMs }: { graceMs?: number } = {}): Promise<void> {
    await this.boss.stop({ graceful: true, close: true, timeout: graceMs });
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
    ...(options.max === undefined ? {} : { max: options.max }),
  });
  boss.on('error', options.onError);
  await boss.start();
  return new PgBossJobQueue(boss, options.stopGraceMs);
}

export { grantRuntimeRole, migratePgBoss, type MigrateOptions } from './migrate.js';
