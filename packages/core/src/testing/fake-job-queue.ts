import type { JobQueue } from '../ports/job-queue.js';

/** In-memory JobQueue for tests. A skeleton: the task T11 fills it in. */
export class FakeJobQueue implements JobQueue {}
