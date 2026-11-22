import type { HocuspocusProvider } from '@hocuspocus/provider';
import { convertInProcess, seedInProcess } from '@tektum/grimoire-adapter-markdown-milkdown';
import { connect } from '@tektum/grimoire-test-support';
import { appUrl, sqlAdmin } from '../server/support/harness.js';
import type * as Y from 'yjs';
import { wsUrl } from './support.js';

export { appUrl };
export const ALICE = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';

/** A client whose document is a real ProseMirror fragment: edits are applied as the update of a seeded document, so the server's converter accepts them. */
export interface DocClient { readonly doc: Y.Doc; readonly provider: HocuspocusProvider; readonly closes: number[]; readonly failures: string[]; destroy(): void }

/** The dev-token subject of a known row (its `descope_user_id`); another value is used as the subject itself. */
const SUBJECTS: Readonly<Record<string, string>> = { [ALICE]: 'alice', [BOB]: 'bob' };

/** `userId` is the row id the test expects in `last_edited_by`; the token carries the row's subject, never the id (R4.12). */
export function connectDoc(port: number, page: string, userId: string, role: 'member' | 'viewer' = 'member'): DocClient {
  const client = connect(wsUrl(port), page, `dev:test-secret-0123456789abcdef:${SUBJECTS[userId] ?? userId}:${role}`);
  return { doc: client.document, provider: client.provider, closes: client.closes, failures: client.failures, destroy: client.destroy };
}

export const stateOfMarkdown = async (markdown: string): Promise<Uint8Array> => {
  const r = await seedInProcess(markdown);
  if (!r.ok) throw new Error(`seed failed: ${r.reason}`);
  return r.state;
};

/** The canonical Markdown of a state, from the same converter the server uses (in process). */
export const markdownOfState = async (state: Uint8Array): Promise<string> => {
  const r = await convertInProcess(state);
  if (!r.ok) throw new Error(`convert failed: ${r.reason}`);
  return r.markdown;
};

export interface Columns {
  ydoc: Buffer | null; markdown: string | null; text_content: string | null; markdown_hash: Buffer | null;
  last_edited_by: string | null; last_edited_at: string | null; updated_at: string; ydoc_size: number | null;
}
export const columnsOf = async (db: string, id: string): Promise<Columns | undefined> => (await sqlAdmin<Columns>(
  db, `select ydoc, ydoc_size, markdown, text_content, markdown_hash, last_edited_by::text, last_edited_at::text, updated_at::text from pages where id = '${id}'`))[0];
