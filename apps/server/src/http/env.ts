import type { Profile } from '@tektum/grimoire-core/ports/auth-verifier';
import type { PageAccessChecker } from '@tektum/grimoire-core/authorize';
import type { Authorizer } from '@tektum/grimoire-core/authorize/authorizer';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { Config } from '@tektum/grimoire-core/ports/config';
import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';
import type { Role, UserRecord, UserStore } from '@tektum/grimoire-core/ports/user-store';
import type { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import type { IdempotencyStore } from '@tektum/grimoire-core/ports/idempotency-store';
import type { CollectionRepo } from '@tektum/grimoire-core/ports/collection-repo';
import type { AuditLog } from '@tektum/grimoire-core/ports/audit-log';
import type { PageRepo } from '@tektum/grimoire-core/ports/page-repo';
import type { TrashRepo } from '@tektum/grimoire-core/ports/trash-repo';
import type { RevisionRepo } from '@tektum/grimoire-core/ports/revision-repo';
import type { AdminRepo } from '@tektum/grimoire-core/ports/admin-repo';
import type { PageStateRepo } from '@tektum/grimoire-core/ports/page-state-repo';
import type { Ordering } from '@tektum/grimoire-core/tree/position';
import type { EventLog } from '../events.js';

export interface Identity { readonly userId: string; readonly profile?: Profile }

/** Every port a route may use. Handlers read it from the context; a router keeps no state of its own. */
export interface HttpDeps {
  readonly config: Config;
  readonly log: EventLog;
  readonly clock: Clock;
  readonly users: UserStore;
  readonly access: PageAccessChecker;
  /** Collection decisions (`checkCollection`, `visibleCollections`). */
  readonly authorizer: Authorizer;
  readonly provisioner: ReturnType<typeof createProvisioner>;
  /** Routes may only seed. The rebuild from stored Markdown belongs to the collaboration host. */
  readonly converter: MarkdownConverter;
  /** Sibling ordering on fractional keys. */
  readonly ordering: Ordering;
  readonly idempotency: IdempotencyStore;
  readonly collections: CollectionRepo;
  readonly audit: AuditLog;
  readonly pages: PageRepo;
  readonly trash: TrashRepo;
  readonly revisions: RevisionRepo;
  readonly admin: AdminRepo;
  readonly pageState: PageStateRepo;
  /** Removes the objects of attachments from the file store (the purge calls it before it deletes any row). */
  readonly deleteFiles: (keys: readonly string[]) => Promise<void>;
}

export type AppEnv = { Variables: { deps: HttpDeps; identity?: Identity; user?: UserRecord; devRole?: Role } };
