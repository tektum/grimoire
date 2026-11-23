import type { AttachmentRepo } from '@tektum/grimoire-core/ports/attachment-repo';
import type { KyselyDatabase } from './index.js';

/** The PostgreSQL AttachmentRepo. A skeleton: the owning task fills it in with the typed handle. */
export function createAttachments(db: KyselyDatabase): AttachmentRepo {
  void db; // the owning task reads from it
  return {};
}
