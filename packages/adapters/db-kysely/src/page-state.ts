import { markdownHash } from '@tektum/grimoire-core/pages/hash';
import type { PageStateRepo, ResetResult } from '@tektum/grimoire-core/ports/page-state-repo';
import { insertAuditEvent } from './audit.js';
import type { KyselyDatabase } from './index.js';

interface Locked { title: string; state_epoch: number; stale: boolean }

/** The PostgreSQL PageStateRepo. */
export function createPageState(db: KyselyDatabase): PageStateRepo {
  return {
    reset({ pageId, actorId, content, confirmStale }) {
      return db.transaction(async (tx): Promise<ResetResult> => {
        // The actor is checked again under a lock that a demotion or a suspension (which takes the row for update) waits for: the right to reset is
        // bound to the commit, not to the moment the request was admitted.
        const actor = await tx.query(`select 1 from users where id = $1 and role = 'admin' and suspended_at is null for share`, [actorId]);
        if (actor.length === 0) return { kind: 'not-admin' };
        const rows = await tx.query<Locked>(
          // A page with a state and no Markdown counts as stale: dropping its state would leave nothing to rebuild it from.
          `select p.title, p.state_epoch, (p.markdown_stale_since is not null or (p.markdown is null and p.ydoc is not null)) as stale from pages p
           where p.id = $1 and p.deleted_at is null and exists (select 1 from collections c where c.id = p.collection_id and c.deleted_at is null) for update of p`,
          [pageId],
        );
        const page = rows[0];
        if (page === undefined) return { kind: 'not-found' };
        // Supplied Markdown replaces the old text, so what was older no longer matters; a kept one that is older than the state is lost work.
        const markdownStale = content === undefined && page.stale;
        if (markdownStale && !confirmStale) return { kind: 'stale-unconfirmed' };
        const epoch = page.state_epoch + 1;
        const sets = ['state_epoch = $2', 'markdown_stale_since = null', 'updated_at = now()'];
        const params: unknown[] = [pageId, epoch];
        if (content === undefined) {
          sets.push('ydoc = null', 'ydoc_size = null');
        } else {
          params.push(Buffer.from(content.state), content.state.length, content.markdown, content.text, markdownHash(page.title, content.markdown));
          sets.push('ydoc = $3', 'ydoc_size = $4', 'markdown = $5', 'text_content = $6', 'markdown_hash = $7');
        }
        // A replacement is never stored without state: the same statement refuses an empty one.
        const guard = content === undefined ? '' : ' and octet_length($3::bytea) > 0';
        const done = await tx.query(`update pages set ${sets.join(', ')} where id = $1${guard} returning id`, params);
        if (done.length === 0) return { kind: 'empty-state' };
        await insertAuditEvent(tx, {
          actorId, action: 'page.state_reset', targetType: 'page', targetId: pageId,
          detail: { stateEpoch: epoch, markdownReplaced: content !== undefined, markdownStale },
        });
        return { kind: 'reset', stateEpoch: epoch, markdownStale };
      });
    },
  };
}
