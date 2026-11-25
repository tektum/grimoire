import { markdownHash } from '@tektum/grimoire-core/pages/hash';
import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';

/** How a page ends stage 4c. `ok` carries what the page row stores, the seeded `state` included (the page writer decides whether the row keeps it, see the PR); `retry` is not the page's fault (a busy converter), so the item stays pending. */
export type PageOutcome =
  | { readonly kind: 'ok'; readonly markdown: string; readonly text: string; readonly hash: Buffer; readonly state: Uint8Array; readonly markdownBytes: number; readonly stateBytes: number }
  | { readonly kind: 'skipped'; readonly reason: string; readonly markdownBytes: number }
  | { readonly kind: 'failed'; readonly reason: string; readonly markdownBytes: number; readonly stateBytes?: number }
  | { readonly kind: 'retry'; readonly reason: string };

/** The converter is busy or shutting down, not at fault: the same refusals the collaboration save counts as busy. */
const isBusy = (reason: string, detail: string): boolean => reason === 'queue-timeout' || (reason === 'internal' && (detail === 'queue-full' || detail === 'closed' || detail === 'one-at-a-time'));

/**
 * Size and conversion, fail-closed (M7 contracts section 4, stage 4c). The Markdown is seeded with the strict limits and converted back; what is stored is the converter's
 * canonical Markdown and text, never the text that came in. A page the editor cannot hold is `skipped` as `too-large-to-seed`; a state over `maxStateBytes` is `failed` as
 * `state_too_large`; any other refusal, at either step, is `failed` with the converter's reason, and no page row is made for it. A busy converter (`queue-timeout`, a full queue,
 * a pool shutting down, or one already working for this importer) is `retry`. No reason carries page text.
 */
export async function normalizePage(converter: MarkdownConverter, importerId: string, title: string, markdown: string, maxStateBytes: number): Promise<PageOutcome> {
  const markdownBytes = Buffer.byteLength(markdown);
  const seed = await converter.seed(markdown, importerId);
  if (!seed.ok) {
    if (isBusy(seed.reason, seed.detail)) return { kind: 'retry', reason: seed.reason };
    if (seed.reason === 'too-large') return { kind: 'skipped', reason: 'too-large-to-seed', markdownBytes };
    return { kind: 'failed', reason: seed.reason, markdownBytes };
  }
  const stateBytes = seed.state.byteLength;
  if (stateBytes > maxStateBytes) return { kind: 'failed', reason: 'state_too_large', markdownBytes, stateBytes };
  const back = await converter.toMarkdown(seed.state);
  if (!back.ok) return isBusy(back.reason, back.detail) ? { kind: 'retry', reason: back.reason } : { kind: 'failed', reason: back.reason, markdownBytes, stateBytes };
  return { kind: 'ok', markdown: back.markdown, text: back.text, hash: markdownHash(title, back.markdown), state: seed.state, markdownBytes, stateBytes };
}
