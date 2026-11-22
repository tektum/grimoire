import { shippedMigration } from '../../../src/health/migrations.js';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeDatabase } from '@tektum/grimoire-core/testing/fake-database';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
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
  const ctx: AppContext = {
    config: makeFakeConfig(),
    log: createEventLog(logger),
    clock,
    db,
    auth: { verifier: { verify: () => Promise.resolve({ kind: 'service-unavailable' }) } },
    signInPolicy: { firstAdminEmails: [], allowedEmailDomains: [], allowDevRole: true },
    shutdown, shutdownHooks: [], testFacilities: [],
  };
  return { ctx, logger, clock, shutdown };
}
