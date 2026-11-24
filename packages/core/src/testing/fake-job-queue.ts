import type { Queryable } from '../ports/database.js';
import { expirySignalDelayMs, type EnqueueOptions, type JobHandler, type JobQueue, type QueueDefinition } from '../ports/job-queue.js';

interface Job {
  readonly id: string;
  readonly name: string;
  readonly payload: unknown;
  readonly singletonKey: string | undefined;
  readonly retryLimit: number;
  readonly expireInSeconds: number;
  runAtMs: number;
  attempt: number;
  state: 'queued' | 'active' | 'done' | 'failed';
}

interface Schedule { readonly everyMinutes: number; readonly payload: unknown; lastMinute: number }

const MINUTE = 60_000;

function parseCron(cron: string): number {
  const m = /^(?:\*|\*\/(\d+)) \* \* \* \*$/.exec(cron);
  if (!m) throw new Error(`the fake queue understands only "* * * * *" and "*/N * * * *", got "${cron}"`);
  const n = m[1] === undefined ? 1 : Number(m[1]);
  if (n < 1) throw new Error('cron step must be at least 1');
  return n;
}

/**
 * In-memory JobQueue with a virtual clock: nothing runs until `advance` is called. Signal aborts (expiry, `stop`) use real
 * timers, because a handler waiting on its signal cannot be woken by a virtual clock. A queue never created with
 * `ensureQueue` has the defaults of a `stately` queue with no retries and a 900 s expiry. Writes made with `tx` go into
 * the table `fake_job_pending` of that transaction first, so a rolled-back transaction leaves no job: the queue
 * adopts rows it finds there when it next runs. The transaction must come from a database that stores that table.
 */
export class FakeJobQueue implements JobQueue {
  private nowMs = 0;
  private seq = 0;
  private readonly jobs: Job[] = [];
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schedules = new Map<string, Schedule>();
  private generation = 0;
  private stopped = false;
  private readonly queues = new Map<string, QueueDefinition>();
  private readonly running = new Set<{ promise: Promise<void>; abort: () => void }>();

  constructor(private readonly committed?: Queryable) {}

  /** Every job ever added, oldest first. */
  get all(): readonly { id: string; name: string; state: string; attempt: number }[] {
    return this.jobs.map(({ id, name, state, attempt }) => ({ id, name, state, attempt }));
  }

  async ensureQueue(definition: QueueDefinition): Promise<void> {
    if (!this.queues.has(definition.name)) this.queues.set(definition.name, definition);
  }

  async enqueue<Payload>(name: string, payload: Payload, options: EnqueueOptions = {}, tx?: Queryable): Promise<string | null> {
    if (tx) {
      if (!this.committed) throw new Error('FakeJobQueue needs the committed database to accept enqueues with tx');
      const key = this.dedupes(name) ? options.singletonKey : undefined;
      if (key !== undefined) {
        const existing = this.queuedWithKey(name, key) ?? (await this.pendingWithKey(tx, name, key));
        if (existing !== undefined) return existing;
      }
      const id = `job-${++this.seq}`;
      await tx.query('insert into fake_job_pending (id, name, payload, options) values ($1, $2, $3, $4)', [id, name, JSON.stringify(payload), JSON.stringify(options)]);
      return id;
    }
    await this.adoptPending(); // committed transactional jobs count for the singleton check
    return this.add(name, payload, options);
  }

  async isLive(name: string, singletonKey: string): Promise<boolean> {
    await this.adoptPending();
    return this.jobs.some((j) => j.name === name && j.singletonKey === singletonKey && (j.state === 'queued' || j.state === 'active'));
  }

  /** Only `short` and `stately` queues (and queues never created) answer a repeated key with the queued job. */
  private dedupes(name: string): boolean {
    const policy = this.queues.get(name)?.policy;
    return policy === undefined || policy === 'short' || policy === 'stately';
  }

  private add(name: string, payload: unknown, options: EnqueueOptions): string {
    const key = this.dedupes(name) ? options.singletonKey : undefined;
    return (key !== undefined ? this.queuedWithKey(name, key) : undefined) ?? this.push(`job-${++this.seq}`, name, payload, options);
  }

  private queuedWithKey(name: string, key: string): string | undefined {
    return this.jobs.find((j) => j.name === name && j.singletonKey === key && j.state === 'queued')?.id;
  }

  /** The id of a not yet adopted write of `tx` with the same name and key (its own or a committed one). */
  private async pendingWithKey(tx: Queryable, name: string, key: string): Promise<string | undefined> {
    const rows = await tx.query<{ id: string; name: string; options: string }>('select id, name, options from fake_job_pending');
    return rows.find((r) => r.name === name && !this.jobs.some((j) => j.id === r.id) && (JSON.parse(r.options) as EnqueueOptions).singletonKey === key)?.id;
  }

  private push(id: string, name: string, payload: unknown, options: EnqueueOptions): string {
    const queue = this.queues.get(name);
    this.jobs.push({
      id, name, payload, singletonKey: options.singletonKey, retryLimit: options.retryLimit ?? queue?.retryLimit ?? 0,
      expireInSeconds: options.expireInSeconds ?? queue?.expireInSeconds ?? 900,
      runAtMs: this.nowMs + (options.delaySeconds ?? 0) * 1000, attempt: 0, state: 'queued',
    });
    return id;
  }

  async work<Payload>(name: string, handler: JobHandler<Payload>): Promise<void> {
    this.handlers.set(name, handler as JobHandler);
  }

  async schedule(name: string, cron: string, payload?: unknown): Promise<void> {
    this.schedules.set(name, { everyMinutes: parseCron(cron), payload, lastMinute: Math.floor(this.nowMs / MINUTE) });
  }

  /** Simulates every worker process dying: handlers are forgotten and running jobs go back to the queue. */
  crashWorkers(): void {
    this.generation++;
    this.handlers.clear();
    for (const j of this.jobs) if (j.state === 'active') { j.state = 'queued'; j.attempt--; }
  }

  /**
   * Moves the clock forward and runs every job that is due, to completion, in due order. With `until`, handlers run
   * concurrently instead and it returns once `until()` is true (or after a few real seconds), so a handler that waits
   * for something that comes later does not hold it up.
   */
  async advance(seconds: number, until?: () => boolean): Promise<void> {
    if (this.stopped) return;
    await this.adoptPending(); // before the clock moves, so a delay counts from the enqueue
    const target = this.nowMs + seconds * 1000;
    for (let minute = Math.floor(this.nowMs / MINUTE) + 1; minute <= Math.floor(target / MINUTE); minute++) {
      for (const [name, s] of this.schedules) {
        if (minute - s.lastMinute >= s.everyMinutes) {
          s.lastMinute = minute;
          this.nowMs = Math.max(this.nowMs, minute * MINUTE);
          this.add(name, s.payload, {});
        }
      }
    }
    this.nowMs = target;
    const giveUp = Date.now() + 5000;
    for (;;) {
      const due = this.stopped ? undefined : this.jobs.filter((j) => j.state === 'queued' && j.runAtMs <= this.nowMs && this.handlers.has(j.name))
        .sort((a, b) => a.runAtMs - b.runAtMs)[0];
      if (!due) {
        if (!until || until() || Date.now() > giveUp) return;
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      } else if (until) void this.run(due);
      else await this.run(due);
    }
  }

  /** Stops running jobs at once (none start again), waits up to `graceMs` for running handlers and aborts the rest at `graceMs - 2000`. */
  async stop({ graceMs }: { graceMs: number }): Promise<{ inFlight: number }> {
    this.stopped = true;
    const abortTimer = setTimeout(() => { for (const r of this.running) r.abort(); }, Math.max(0, graceMs - 2000));
    let graceTimer: NodeJS.Timeout | undefined;
    const graceOver = new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, graceMs); });
    await Promise.race([Promise.all([...this.running].map((r) => r.promise)), graceOver]);
    clearTimeout(abortTimer);
    clearTimeout(graceTimer);
    return { inFlight: this.running.size };
  }

  private async adoptPending(): Promise<void> {
    if (!this.committed) return;
    const rows = await this.committed.query<{ id: string; name: string; payload: string; options: string }>('select id, name, payload, options from fake_job_pending');
    for (const r of rows) {
      if (this.jobs.some((j) => j.id === r.id)) continue;
      const options = JSON.parse(r.options) as EnqueueOptions;
      if (this.dedupes(r.name) && options.singletonKey !== undefined && this.queuedWithKey(r.name, options.singletonKey) !== undefined) continue;
      this.push(r.id, r.name, JSON.parse(r.payload), options);
    }
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers.get(job.name) as JobHandler;
    const generation = this.generation;
    const abort = new AbortController();
    const timer = setTimeout(() => { abort.abort(); }, expirySignalDelayMs(job.expireInSeconds));
    job.state = 'active';
    job.attempt++;
    let failed = false;
    const entry = { abort: () => { abort.abort(); }, promise: Promise.resolve() };
    this.running.add(entry);
    entry.promise = (async () => {
      try {
        await handler(job.payload, { jobId: job.id, attempt: job.attempt, retryLimit: job.retryLimit, signal: abort.signal });
      } catch {
        failed = true;
      } finally {
        clearTimeout(timer);
        this.running.delete(entry);
      }
    })();
    await entry.promise;
    if (generation !== this.generation) return; // the workers crashed while it ran: crashWorkers requeued it
    if (!failed) job.state = 'done';
    else if (job.attempt <= job.retryLimit) { job.state = 'queued'; job.runAtMs = this.nowMs; }
    else job.state = 'failed';
  }
}
