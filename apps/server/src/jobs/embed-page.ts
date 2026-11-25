import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';

/** The payload of an `embed-page` job (decision 4: every payload names its tenant). */
export interface EmbedPagePayload { readonly tenantId: string; readonly pageId: string }

/** M7-T13 fills this in: chunk the page, embed the chunks that changed and store them. Registered now so the queue is worked and the wiring is proved. */
export const handleEmbedPage: JobHandler<EmbedPagePayload> = () => Promise.resolve();
