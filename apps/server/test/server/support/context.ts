import { shippedMigration } from '../../../src/health/migrations.js';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeDatabase } from '@tektum/grimoire-core/testing/fake-database';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { FakeImportRepo } from '@tektum/grimoire-core/testing/fake-import-repo';
import { FakeSearchRepo } from '@tektum/grimoire-core/testing/fake-search-repo';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeAdminRepo } from '@tektum/grimoire-core/testing/fake-admin-repo';
import { FakeAuditLog } from '@tektum/grimoire-core/testing/fake-audit-log';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { FakePageRepo } from '@tektum/grimoire-core/testing/fake-page-repo';
import { FakePageStateRepo } from '@tektum/grimoire-core/testing/fake-page-state-repo';
import { FakeAttachmentRepo } from '@tektum/grimoire-core/testing/fake-attachment-repo';
import { FakeRevisionRepo } from '@tektum/grimoire-core/testing/fake-revision-repo';
import { FakeTrashRepo } from '@tektum/grimoire-core/testing/fake-trash-repo';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import type { AppContext } from '../../../src/composition.js';
import { createEventLog } from '../../../src/events.js';
import { Shutdown } from '../../../src/lifecycle/shutdown.js';

export interface TestContext {
  readonly ctx: AppContext;
  readonly logger: FakeLogger;
  readonly clock: FakeClock;
  readonly shutdown: Shutdown;
}

/** A database that answers the migration probe; pass `migrated: false` for an unmigrated one. */
/** `migrated` false means no migration is applied; a string is the latest applied migration name. */
export function fakeDatabase(migrated: boolean | string = true): FakeDatabase {
  const version = migrated === true ? shippedMigration() : migrated === false ? null : migrated;
  return new FakeDatabase(() => [{ version }]);
}

export function makeContext(db: FakeDatabase = fakeDatabase()): TestContext {
  const logger = new FakeLogger();
  const clock = new FakeClock(1000);
  const shutdown = new Shutdown(clock);
  const config = makeFakeConfig();
  const log = createEventLog(logger);
  const verifier = { verify: () => Promise.resolve({ kind: 'service-unavailable' as const }) };
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: [], refusedEmailDomains: [], allowDevRole: true };
  const users = new FakeUserStore();
  const http: AppContext['http'] = {
    config, providerBaseUrl: null, log, clock, users, access: createPageAccess(createFakeAccessStore(emptyWorld())),
    authorizer: createAuthorizer(createFakeAccessStore(emptyWorld())),
    provisioner: createProvisioner({ users, verifier, policy: signInPolicy, logger }),
    ordering: new FakeOrdering(), converter: new FakeMarkdownConverter(), search: new FakeSearchRepo(), imports: new FakeImportRepo(),
    idempotency: new FakeIdempotencyStore(), collections: new FakeCollectionRepo(), audit: new FakeAuditLog(),
    pages: new FakePageRepo(), trash: new FakeTrashRepo(), revisions: new FakeRevisionRepo(), admin: new FakeAdminRepo(), pageState: new FakePageStateRepo(), attachments: new FakeAttachmentRepo(), deleteFiles: () => Promise.resolve(),
  };
  const ctx: AppContext = {
    config, log, clock, db, http,
    auth: { verifier }, signInPolicy,
    shutdown, shutdownHooks: [], testFacilities: [],
  };
  return { ctx, logger, clock, shutdown };
}
