import type { Extension, HookPayloadByName } from '@hocuspocus/server';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { RevisionRepo } from '@tektum/grimoire-core/ports/revision-repo';
import { readContext } from '../context.js';
import type { CollabLog } from '../events.js';
import { createRevisionScheduler } from '../revisions/scheduler.js';
import type { RevisionScheduler, SchedulerReport, Timers } from '../revisions/scheduler.js';

export interface RevisionsOptions {
  readonly repo: RevisionRepo;
  readonly clock: Clock;
  readonly log: CollabLog;
  /** Timers for the 5-minute rule; default the global ones, tests pass fake ones. */
  readonly timers?: Timers;
}

/** The log events of the revision rules: the only place that names them. */
export const revisionReport = (log: CollabLog): SchedulerReport => ({
  created: (pageId, reason) => { log.emit('collab.revision_created', { pageId, reason }); },
  deferred: (pageId) => { log.emit('collab.revision_deferred', { pageId }); },
  failed: (pageId, errorName) => { log.emit('collab.revision_failed', { pageId, errorName }); },
});

export interface RevisionsExtension extends Extension {
  readonly scheduler: RevisionScheduler;
}

/** Page revisions (R9.2, R9.3) as a host extension: it only translates Hocuspocus hooks into the scheduler's calls, without waiting for them. Lowest priority, so it runs after saves. */
export function createRevisionsExtension(o: RevisionsOptions): RevisionsExtension {
  const scheduler = createRevisionScheduler({ repo: o.repo, clock: o.clock, report: revisionReport(o.log), ...(o.timers ? { timers: o.timers } : {}) });
  return {
    extensionName: 'grimoire-revisions',
    priority: 10,
    scheduler,
    async afterLoadDocument(): Promise<void> {
      scheduler.opened();
    },
    async onChange(data: HookPayloadByName['onChange']): Promise<void> {
      const c = readContext(data.context);
      scheduler.changed(data.documentName, c.userId, c.tenantId ?? 'legacy');
    },
    // Revision work never holds up the host: a slow or hung database must not delay a store, an unload or the shutdown. The scheduler
    // catches and logs its own failures, so the promises it returns never reject.
    async afterStoreDocument(data: HookPayloadByName['afterStoreDocument']): Promise<void> {
      void scheduler.saved(data.documentName);
    },
    async afterUnloadDocument(data: HookPayloadByName['afterUnloadDocument']): Promise<void> {
      void scheduler.unloaded(data.documentName);
    },
    async onDestroy(): Promise<void> {
      scheduler.stop();
    },
  };
}
