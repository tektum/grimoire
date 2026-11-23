import type { SeededContent } from '../pages/seeded-content.js';

export interface ResetInput {
  readonly pageId: string;
  readonly actorId: string;
  /** Replacement Markdown with the state it was seeded into (strict limits, done before the call). Without it the stored Markdown stays. */
  readonly content?: SeededContent;
  /** The admin knows the saved Markdown is older than the state and accepts losing the newest edits. */
  readonly confirmStale: boolean;
}

/**
 * `reset`: the state is gone (or replaced), the epoch is one higher, the audit row is written. `markdownStale` is true when the Markdown that
 * was kept was older than the state it replaced. `stale-unconfirmed`: nothing changed, the page's Markdown is older than its state and
 * `confirmStale` was not given. `empty-state`: the replacement had no state, nothing changed.
 */
export type ResetResult =
  | { kind: 'reset'; stateEpoch: number; markdownStale: boolean }
  | { kind: 'not-found' }
  | { kind: 'not-admin' }
  | { kind: 'stale-unconfirmed' }
  | { kind: 'empty-state' };

/** Resetting a page's editor state. */
export interface PageStateRepo {
  /** One transaction with the row locked: state, epoch and (with `content`) Markdown, search text and hash change together, with the audit row `page.state_reset`. */
  reset(input: ResetInput): Promise<ResetResult>;
}
