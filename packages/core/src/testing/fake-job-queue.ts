import type { Queryable } from '../ports/database.js';
import type { EnqueueOptions, JobHandler, JobQueue } from '../ports/job-queue.js';

interface Job {
  readonly id: string;
  readonly name: string;
  readonly payload: unknown;
  readonly singletonKey: string | undefined;
  readonly retryLimit: number;
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
 * In-memory JobQueue with a virtual clock: nothing runs until `advance` is called. Writes made with `tx` go into
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

  constructor(private readonly committed?: Queryable) {}

  /** Every job ever added, oldest first. */
  get all(): readonly { id: string; name: string; state: string; attempt: number }[] {
    return this.jobs.map(({ id, name, state, attempt }) => ({ id, name, state, attempt }));
  }

  async enqueue<Payload>(name: string, payload: Payload, options: EnqueueOptions = {}, tx?: Queryable): Promise<string | null> {
    if (tx) {
      if (!this.committed) throw new Error('FakeJobQueue needs the committed database to accept enqueues with tx');
      const key = options.singletonKey;
      if (key !== undefined && (this.hasLiveSingleton(name, key) || (await this.pendingSingleton(tx, name, key)))) return null;
      const id = `job-${++this.seq}`;
      await tx.query('insert into fake_job_pending (id, name, payload, options) values ($1, $2, $3, $4)', [id, name, JSON.stringify(payload), JSON.stringify(options)]);
      return id;
    }
    await this.adoptPending(); // committed transactional jobs count for the singleton check
    return this.add(name, payload, options);
  }

  private add(name: string, payload: unknown, options: EnqueueOptions): string | null {
    const key = options.singletonKey;
    if (key !== undefined && this.hasLiveSingleton(name, key)) return null;
    return this.push(`job-${++this.seq}`, name, payload, options);
  }

  private hasLiveSingleton(name: string, key: string): boolean {
    return this.jobs.some((j) => j.name === name && j.singletonKey === key && (j.state === 'queued' || j.state === 'active'));
  }

  /** True when `tx` holds a not yet adopted write with the same name and key (its own or a committed one). */
  private async pendingSingleton(tx: Queryable, name: string, key: string): Promise<boolean> {
    const rows = await tx.query<{ id: string; name: string; options: string }>('select id, name, options from fake_job_pending');
    return rows.some((r) => r.name === name && !this.jobs.some((j) => j.id === r.id) && (JSON.parse(r.options) as EnqueueOptions).singletonKey === key);
  }

  private push(id: string, name: string, payload: unknown, options: EnqueueOptions): string {
    this.jobs.push({
      id, name, payload, singletonKey: options.singletonKey, retryLimit: options.retryLimit ?? 0,
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

  /** Moves the clock forward and runs every job that is due, to completion, in due order. */
  async advance(seconds: number): Promise<void> {
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
    for (;;) {
      const due = this.jobs.filter((j) => j.state === 'queued' && j.runAtMs <= this.nowMs && this.handlers.has(j.name))
        .sort((a, b) => a.runAtMs - b.runAtMs)[0];
      if (!due) return;
      await this.run(due);
    }
  }

  private async adoptPending(): Promise<void> {
    if (!this.committed) return;
    const rows = await this.committed.query<{ id: string; name: string; payload: string; options: string }>('select id, name, payload, options from fake_job_pending');
    for (const r of rows) {
      if (this.jobs.some((j) => j.id === r.id)) continue;
      const options = JSON.parse(r.options) as EnqueueOptions;
      if (options.singletonKey !== undefined && this.hasLiveSingleton(r.name, options.singletonKey)) continue;
      this.push(r.id, r.name, JSON.parse(r.payload), options);
    }
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers.get(job.name) as JobHandler;
    const generation = this.generation;
    job.state = 'active';
    job.attempt++;
    let failed = false;
    try {
      await handler(job.payload, { id: job.id, attempt: job.attempt });
    } catch {
      failed = true;
    }
    if (generation !== this.generation) return; // the workers crashed while it ran: crashWorkers requeued it
    if (!failed) job.state = 'done';
    else if (job.attempt <= job.retryLimit) { job.state = 'queued'; job.runAtMs = this.nowMs; }
    else job.state = 'failed';
  }
}
