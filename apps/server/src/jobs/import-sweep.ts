import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';

/** The `import-sweep` job. The work lands in a later M7 task; until then it fails, so a job that reaches it is retried and shows up, not dropped. */
export const handleImportSweep: JobHandler = () => Promise.reject(new Error('the import-sweep job is not available yet'));
