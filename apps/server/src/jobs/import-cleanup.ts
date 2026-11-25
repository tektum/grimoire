import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';

/** The `import-cleanup` job. The work lands in a later M7 task; until then it fails, so a job that reaches it is retried and shows up, not dropped. */
export const handleImportCleanup: JobHandler = () => Promise.reject(new Error('the import-cleanup job is not available yet'));
