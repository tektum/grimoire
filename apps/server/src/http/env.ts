import type { Profile, TenantClaim } from '@tektum/grimoire-core/ports/auth-verifier';
import type { PageAccessChecker } from '@tektum/grimoire-core/authorize';
import type { Authorizer } from '@tektum/grimoire-core/authorize/authorizer';
import type { AttachmentRepo } from '@tektum/grimoire-core/ports/attachment-repo';
import type { FileStorage } from '@tektum/grimoire-core/ports/file-storage';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { Config } from '@tektum/grimoire-core/ports/config';
import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';
import type { ImportRepo } from '@tektum/grimoire-core/ports/import-repo';
import type { EnqueueOptions } from '@tektum/grimoire-core/ports/job-queue';
import type { SearchRepo } from '@tektum/grimoire-core/ports/search-repo';
import type { SemanticSearch } from '@tektum/grimoire-core/search/hybrid-search';
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

export interface Identity { readonly userId: string; readonly profile?: Profile; readonly tenant?: TenantClaim }

/** Every port a route may use. Handlers read it from the context; a router keeps no state of its own. */
export interface HttpDeps {
  readonly config: Config;
  /** The sign-in provider endpoint browsers use, as the server's own provider calls use it (region from the project id, a configured URL without trailing slashes); null without a project. */
  readonly providerBaseUrl?: string | null;
  readonly log: EventLog;
  readonly clock: Clock;
  readonly users: UserStore;
  readonly access: PageAccessChecker;
  /** Collection decisions (`checkCollection`, `visibleCollections`). */
  readonly authorizer: Authorizer;
  readonly provisioner: ReturnType<typeof createProvisioner>;
  /** Routes may only seed. The rebuild from stored Markdown belongs to the collaboration host. */
  readonly converter: MarkdownConverter;
  /** Search over the pages a user may read (M7-T01 fills the adapter). */
  readonly search: SearchRepo;
  /** The semantic part of the search (M7-T14): the model, the vectors and the settings. Absent when the setting is off, the role has no embedder or the store is not wired: the search is full text alone. */
  readonly hybrid?: SemanticSearch;
  /** The imports of the caller's tenant (M7-T04 fills the adapter). */
  readonly imports: ImportRepo;
  /** Hands the job of an import to the queue (the import start): its payload is the ids and nothing else (decision 4). Rejects with `jobs-unavailable` while there is no queue (the `collab` role has none, and the queue may not be up yet). */
  enqueueImport(payload: { readonly importId: string; readonly tenantId: string }, options?: EnqueueOptions): Promise<string | null>;
  /** Hands the cleanup of an import that is over to the queue (a cancel): ids only. Rejects like `enqueueImport`. */
  enqueueImportCleanup(payload: { readonly importId: string; readonly tenantId: string }): Promise<string | null>;
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
  readonly attachments: AttachmentRepo;
  /** The file store; absent when the files settings are not given (the file routes then answer 503). */
  readonly files?: FileStorage;
  /** Removes the objects of attachments from the file store (the purge calls it before it deletes any row). */
  readonly deleteFiles: (keys: readonly string[]) => Promise<void>;
}

export type AppEnv = { Variables: { deps: HttpDeps; identity?: Identity; user?: UserRecord; devRole?: Role } };
