import { CronExpressionParser } from 'cron-parser';
import { PgBoss, type ConstructorOptions, type JobWithMetadata } from 'pg-boss';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import { expirySignalDelayMs, type EnqueueOptions, type JobHandler, type JobQueue, type QueueDefinition } from '@tektum/grimoire-core/ports/job-queue';
import { scheduleKey } from '@tektum/grimoire-core/jobs/queues';

/** The schema pg-boss keeps its tables in; the Kysely migrations never touch it. */
export const PGBOSS_SCHEMA = 'pgboss';

/** Stop waits this long for running jobs by default; the server checks that it fits the release step of the shutdown budget. */
export const DEFAULT_STOP_GRACE_MS = 1500;

/** The part of pg-boss the adapter uses; tests pass a stand-in. */
export type PgBossLike = Pick<PgBoss, 'start' | 'stop' | 'send' | 'work' | 'cancel' | 'createQueue' | 'getQueue' | 'findJobs' | 'getDb' | 'isInstalled' | 'on'>;

/** The database object pg-boss accepts for one call (`db` option). */
interface PgBossDatabase { executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }

/** Hands a Kysely transaction (or any Queryable) to pg-boss as its database for one call. */
function asDatabase(tx: Queryable): PgBossDatabase {
  return { executeSql: async (text: string, values?: unknown[]) => ({ rows: [...(await tx.query(text, values))] }) };
}

/** The first time of a five-field UTC cron after `after`. */
const nextRun = (cron: string, after: Date): Date => CronExpressionParser.parse(cron, { currentDate: after, tz: 'UTC' }).next().toDate();
/** Whether `at` is a time of the cron (cron times fall on whole minutes). */
const isRunTime = (cron: string, at: Date): boolean => nextRun(cron, new Date(at.getTime() - 1000)).getTime() === at.getTime();

/** Creates the queue unless it exists; an existing one is left as it is. */
export async function ensureQueueOn(boss: Pick<PgBoss, 'getQueue' | 'createQueue'>, definition: QueueDefinition): Promise<void> {
  if (await boss.getQueue(definition.name)) return;
  await boss.createQueue(definition.name, queueOptions(definition));
}

export function queueOptions(definition: QueueDefinition) {
  return {
    policy: definition.policy,
    retryLimit: definition.retryLimit,
    retryDelay: definition.retryDelaySeconds,
    retryBackoff: definition.retryBackoff,
    expireInSeconds: definition.expireInSeconds,
    retentionSeconds: definition.retentionSeconds,
    ...(definition.deadLetter === undefined ? {} : { deadLetter: definition.deadLetter }),
  };
}

export class PgBossJobQueue implements JobQueue {
  /** The abort controllers of the handlers that are running now. */
  private readonly running = new Set<AbortController>();

  /** The schedules of this process: the cron and payload that each run sends its successor with. */
  private readonly schedules = new Map<string, { readonly cron: string; readonly payload: unknown }>();

  constructor(
    private readonly boss: PgBossLike,
    private readonly stopGraceMs: number = DEFAULT_STOP_GRACE_MS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Creates the queue unless it exists. Run it with a role that may create tables (`grimoire migrate`), before `work`, `schedule` or `enqueue` use the name. */
  ensureQueue(definition: QueueDefinition): Promise<void> {
    return ensureQueueOn(this.boss, definition);
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
    // Inside the caller's transaction its own uncommitted job is the one that holds the key.
    const [existing] = await this.boss.findJobs(name, { key: options.singletonKey, queued: true, limit: 1, ...(tx ? { db: asDatabase(tx) } : {}) });
    return existing?.id ?? null;
  }

  async isLive(name: string, singletonKey: string): Promise<boolean> {
    // States are ordered created, retry, active, completed, cancelled, failed; the first three are live.
    const { rows } = await this.boss.getDb().executeSql(`select 1 from ${PGBOSS_SCHEMA}.job where name = $1 and singleton_key = $2 and state <= 'active' limit 1`, [name, singletonKey]);
    return rows.length > 0;
  }

  async work<Payload>(name: string, handler: JobHandler<Payload>): Promise<void> {
    await this.boss.work<Payload, void, { includeMetadata: true }>(name, { includeMetadata: true }, async (jobs: JobWithMetadata<Payload>[]) => {
      for (const job of jobs) {
        // The successor is sent before the handler: a run that fails, or is dead-lettered, does not end the schedule. A send that fails does not stop the run either: the
        // handler runs, the send is tried once more after it, and only then does the run fail (pg-boss retries it, and a retry sends again).
        let sendFailure: unknown;
        if (this.schedules.has(name)) await this.sendNext(name, job.startAfter).catch((e: unknown) => { sendFailure = e; });
        const own = new AbortController();
        this.running.add(own);
        const timer = setTimeout(() => { own.abort(); }, expirySignalDelayMs(job.expireInSeconds));
        try {
          const signal = job.signal ? AbortSignal.any([own.signal, job.signal]) : own.signal;
          await handler(job.data, { jobId: job.id, attempt: job.retryCount + 1, retryLimit: job.retryLimit, signal });
        } finally {
          clearTimeout(timer);
          this.running.delete(own);
          if (sendFailure !== undefined) await this.sendNext(name, job.startAfter).then(() => { sendFailure = undefined; }, () => undefined);
        }
        if (sendFailure !== undefined) throw sendFailure;
      }
    });
  }

  /**
   * Schedules without pg-boss's cron loop (which the runtime role cannot start, decision 16): the next run is a job with the key `sched:<name>` and its start time,
   * on a `stately` queue, so at most one waits. Every run sends its successor before it starts (`work`), and each process sends the first at boot, where a second one collapses into
   * the first. A waiting run that is not the next time of this cron (the cron was changed) is cancelled and replaced; a late one stays and runs once. What the queue holds is the run, not the cron: a process that still has the old cron sends its successor with it, until the next run of a current one.
   */
  async schedule(name: string, cron: string, payload?: unknown): Promise<void> {
    const next = nextRun(cron, this.now());
    this.schedules.set(name, { cron, payload });
    // `queued` also matches a failed run that waits to be retried, whose start time is no time of the cron: only the run that waits (created) counts.
    const waiting = (await this.boss.findJobs<unknown>(name, { key: scheduleKey(name), queued: true, limit: 10 })).find((j) => j.state === 'created');
    if (waiting !== undefined) {
      if (waiting.startAfter.getTime() <= next.getTime() && isRunTime(cron, waiting.startAfter)) return; // the next time, or a late one that runs once
      await this.boss.cancel(name, waiting.id);
    }
    await this.sendRun(name, payload, next);
  }

  /** The next run after the later of now and the start of the run that is going (the clocks of the servers and the database may differ). */
  private async sendNext(name: string, runStart?: Date): Promise<void> {
    const s = this.schedules.get(name) as { readonly cron: string; readonly payload: unknown };
    const now = this.now();
    await this.sendRun(name, s.payload, nextRun(s.cron, runStart !== undefined && runStart > now ? runStart : now));
  }

  private async sendRun(name: string, payload: unknown, startAfter: Date): Promise<void> {
    await this.boss.send(name, (payload ?? null) as object | null, { singletonKey: scheduleKey(name), startAfter });
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
    schedule: false,
    ...(options.max === undefined ? {} : { max: options.max }),
  });
  boss.on('error', options.onError);
  await boss.start();
  return new PgBossJobQueue(boss, options.stopGraceMs);
}

export { grantRuntimeRole, migratePgBoss, type MigrateOptions } from './migrate.js';
