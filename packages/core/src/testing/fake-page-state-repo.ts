import type { AuditEvent } from '../ports/audit-log.js';
import type { PageStateRepo, ResetInput, ResetResult } from '../ports/page-state-repo.js';

export interface FakePageState {
  state: Uint8Array | null;
  markdown: string | null;
  text: string | null;
  epoch: number;
  stale: boolean;
}

/** In-memory PageStateRepo for tests. A refusal changes nothing and writes nothing, as the transaction does. */
export class FakePageStateRepo implements PageStateRepo {
  readonly audit: AuditEvent[] = [];
  private readonly pages = new Map<string, FakePageState>();

  /** Test setup: a live page with a saved state. */
  track(id: string, page: Partial<FakePageState> = {}): void {
    this.pages.set(id, { state: new Uint8Array([9]), markdown: null, text: null, epoch: 0, stale: false, ...page });
  }

  stored(id: string): Readonly<FakePageState> | undefined {
    const page = this.pages.get(id);
    return page === undefined ? undefined : { ...page };
  }

  reset({ pageId, actorId, content, confirmStale }: ResetInput): Promise<ResetResult> {
    const page = this.pages.get(pageId);
    if (page === undefined) return Promise.resolve({ kind: 'not-found' });
    const markdownStale = content === undefined && page.stale;
    if (markdownStale && !confirmStale) return Promise.resolve({ kind: 'stale-unconfirmed' });
    if (content !== undefined && content.state.length === 0) return Promise.resolve({ kind: 'empty-state' });
    page.epoch += 1;
    page.stale = false;
    page.state = content === undefined ? null : content.state;
    if (content !== undefined) {
      page.markdown = content.markdown;
      page.text = content.text;
    }
    this.audit.push({ actorId, action: 'page.state_reset', targetType: 'page', targetId: pageId, detail: { stateEpoch: page.epoch, markdownReplaced: content !== undefined, markdownStale } });
    return Promise.resolve({ kind: 'reset', stateEpoch: page.epoch, markdownStale });
  }
}
