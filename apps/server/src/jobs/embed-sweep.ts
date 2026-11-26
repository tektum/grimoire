import type { Embedder } from '@tektum/grimoire-core/ports/embedder';
import type { EmbeddingStore } from '@tektum/grimoire-core/ports/embedding-store';
import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';
import type { TenantRepo } from '@tektum/grimoire-core/ports/tenant-repo';
import { modelKey } from '@tektum/grimoire-core/semantic/model-key';
import type { EventLog } from '../events.js';
import type { JobsApi } from './runner.js';
import { forEachTenant } from './tenants.js';

/** Pages a run hands to `embed-page`, per tenant (contracts 15.4: 50 at a time, also when a model change re-embeds every page). */
export const SWEEP_PAGES = 50;

export interface EmbedSweepDeps {
  readonly tenants: Pick<TenantRepo, 'ids'>;
  readonly store: Pick<EmbeddingStore, 'pagesNeedingEmbedding' | 'counts'>;
  readonly embedder: Pick<Embedder, 'status' | 'model'>;
  readonly queue: Pick<JobsApi, 'enqueueEmbedSweep' | 'enqueueEmbedPage'>;
  readonly log: Pick<EventLog, 'info'>;
  readonly sweepSeconds: number;
  readonly debounceSeconds: number;
}

/**
 * The `embed-sweep` job (contracts 15.4, amendment 16a): a chain of runs, each sending the next one `sweepSeconds` on before it does anything else, so a run that fails or is retried never ends the chain
 * (the runs' key makes a repeated send one waiting run). A run hands to `embed-page` the pages of each tenant whose Markdown or model changed and that were left alone for `debounceSeconds`, at most 50 a
 * tenant; the key `embed:<pageId>` makes a page that is already waiting one job. No save calls it, and it reads no text.
 *
 * A model change needs nothing more: the pages whose state names the old model are selected like any page whose Markdown changed, 50 a run, and `embed-page` replaces each one's rows as it goes (search reads
 * the rows of the active model only, so its coverage rises while this runs). The first run of a process that knows the model's key says how many pages are in that case, once (`semantic.reembed_started`;
 * a restart in the middle of a rollout says it again, for the pages that are left).
 */
export function createEmbedSweep(deps: EmbedSweepDeps): JobHandler<unknown> {
  let looked = false;
  return async (_payload, ctx) => {
    await deps.queue.enqueueEmbedSweep(deps.sweepSeconds);
    if (deps.embedder.status() !== 'ready') return; // the key of the model is known once it has loaded: the next run looks again
    const model = modelKey(deps.embedder.model);
    if (!looked) {
      const { pagesOtherModel } = await deps.store.counts(model);
      looked = true;
      if (pagesOtherModel > 0) deps.log.info('semantic.reembed_started', { model, pages: pagesOtherModel });
    }
    await forEachTenant(await deps.tenants.ids(), ctx.signal, async (tenantId) => {
      for (const page of await deps.store.pagesNeedingEmbedding(tenantId, model, { olderThanSeconds: deps.debounceSeconds, limit: SWEEP_PAGES })) {
        await deps.queue.enqueueEmbedPage({ tenantId, pageId: page.pageId });
      }
    });
  };
}
