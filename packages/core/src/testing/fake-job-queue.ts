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
      await tx.query('insert into fake_job_pending (name, payload, options) values ($1, $2, $3)', [name, JSON.stringify(payload), JSON.stringify(options)]);
      return `pending-${name}`;
    }
    return this.add(name, payload, options);
  }

  private add(name: string, payload: unknown, options: EnqueueOptions): string | null {
    const key = options.singletonKey;
    if (key !== undefined && this.jobs.some((j) => j.name === name && j.singletonKey === key && (j.state === 'queued' || j.state === 'active'))) return null;
    const id = `job-${++this.seq}`;
    this.jobs.push({
      id, name, payload, singletonKey: key, retryLimit: options.retryLimit ?? 0,
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
    await this.adoptPending();
    for (;;) {
      const due = this.jobs.filter((j) => j.state === 'queued' && j.runAtMs <= this.nowMs && this.handlers.has(j.name))
        .sort((a, b) => a.runAtMs - b.runAtMs)[0];
      if (!due) return;
      await this.run(due);
    }
  }

  private async adoptPending(): Promise<void> {
    if (!this.committed) return;
    const rows = await this.committed.query<{ name: string; payload: string; options: string }>('select name, payload, options from fake_job_pending');
    for (const r of rows.slice(this.adopted)) this.add(r.name, JSON.parse(r.payload), JSON.parse(r.options) as EnqueueOptions);
    this.adopted = rows.length;
  }

  private adopted = 0;

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
