import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';

/** The `import` job. The work lands in a later M7 task; until then it fails, so a job that reaches it is retried and shows up, not dropped. */
export const handleImport: JobHandler = () => Promise.reject(new Error('the import job is not available yet'));
