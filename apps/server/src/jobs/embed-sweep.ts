import type { Embedder } from '@tektum/grimoire-core/ports/embedder';
import type { EmbeddingStore } from '@tektum/grimoire-core/ports/embedding-store';
import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';
import type { TenantRepo } from '@tektum/grimoire-core/ports/tenant-repo';
import { modelKey } from '@tektum/grimoire-core/semantic/model-key';
import type { JobsApi } from './runner.js';
import { forEachTenant } from './tenants.js';

/** Pages a run hands to `embed-page`, per tenant (contracts 15.4: 50 at a time, also when a model change re-embeds every page). */
export const SWEEP_PAGES = 50;

export interface EmbedSweepDeps {
  readonly tenants: Pick<TenantRepo, 'ids'>;
  readonly store: Pick<EmbeddingStore, 'pagesNeedingEmbedding'>;
  readonly embedder: Pick<Embedder, 'status' | 'model'>;
  readonly queue: Pick<JobsApi, 'enqueueEmbedSweep' | 'enqueueEmbedPage'>;
  readonly sweepSeconds: number;
  readonly debounceSeconds: number;
}

/**
 * The `embed-sweep` job (contracts 15.4, amendment 16a): a chain of runs, each sending the next one `sweepSeconds` on before it does anything else, so a run that fails or is
 * retried never ends the chain (the runs' key makes a repeated send one waiting run). A run hands to `embed-page` the pages of each tenant whose Markdown or model changed and
 * that were left alone for `debounceSeconds`, at most 50 a tenant; the key `embed:<pageId>` makes a page that is already waiting one job. No save calls it, and it reads no text.
 */
export function createEmbedSweep(deps: EmbedSweepDeps): JobHandler<unknown> {
  return async (_payload, ctx) => {
    await deps.queue.enqueueEmbedSweep(deps.sweepSeconds);
    if (deps.embedder.status() !== 'ready') return; // the key of the model is known once it has loaded: the next run looks again
    const model = modelKey(deps.embedder.model);
    await forEachTenant(await deps.tenants.ids(), ctx.signal, async (tenantId) => {
      for (const page of await deps.store.pagesNeedingEmbedding(tenantId, model, { olderThanSeconds: deps.debounceSeconds, limit: SWEEP_PAGES })) {
        await deps.queue.enqueueEmbedPage({ tenantId, pageId: page.pageId });
      }
    });
  };
}
