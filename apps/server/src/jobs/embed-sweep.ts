import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';

/** M7-T13 fills this in: pick the pages whose Markdown changed and enqueue `embed-page` for each. Registered now so the queue is worked and the wiring is proved. */
export const handleEmbedSweep: JobHandler = () => Promise.resolve();
