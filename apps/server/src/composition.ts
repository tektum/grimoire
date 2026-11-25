// Composition root: the only module that constructs adapters and wires them into the core ports.
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import { createJobQueue, migratePgBoss } from '@tektum/grimoire-adapter-jobs-pgboss';
import { jobQueues } from '@tektum/grimoire-core/jobs/queues';
import type { QueueDefinition } from '@tektum/grimoire-core/ports/job-queue';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { Config, FilesSetupConfig } from '@tektum/grimoire-core/ports/config';
import type { CollabDeps, CollaborationHost } from '@tektum/grimoire-core/ports/collaboration-host';
import type { Database } from '@tektum/grimoire-core/ports/database';
import type { DevRoleSource } from '@tektum/grimoire-core/ports/dev-role';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import type { PageAccessChecker } from '@tektum/grimoire-core/authorize';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import type { SignInPolicy } from '@tektum/grimoire-core/users/provisioner';
import { createCollabHost } from '@tektum/grimoire-adapter-collab-hocuspocus';
import { createDevAuth } from '@tektum/grimoire-adapter-auth-dev';
import { createDescopeVerifier, descopeBaseUrl } from '@tektum/grimoire-adapter-auth-descope';
import { checkCors, createBucket, createFileStorage, ensureBucket } from '@tektum/grimoire-adapter-files-s3';
import { ConfigError, type ConfigProblem, loadConfig, parseTestFacilities, loadConfigFromProcessEnv } from '@tektum/grimoire-adapter-config-env';
import type { Env } from '@tektum/grimoire-adapter-config-env';
import { deleteObjects } from './attachments/deps.js';
import { adoptTenant, createAccessStore, createAttachments, createAdmin, createAudit, createCollections, createDatabase, createImportRepo, createSearchRepo, setupDatabase, createIdempotency, createPageState, createPages, createPageStore, createRevisions, createTrash, createUserStore, withMigrationLock, runMigrations as migrateDatabase } from '@tektum/grimoire-adapter-db-kysely';
import type { KyselyDatabase, TenantAdoptRequest, TenantAdoptResult } from '@tektum/grimoire-adapter-db-kysely';
import { createMarkdownConverter } from '@tektum/grimoire-adapter-markdown-milkdown';
import { createJobRunner } from './jobs/runner.js';
import type { JobRunner } from './jobs/runner.js';
import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';
import { createJsonLogger } from '@tektum/grimoire-adapter-logger-json';
import { createOrdering } from './tree/position.js';
import type { HttpDeps } from './http/env.js';
import { createEventLog } from './events.js';
import type { EventLog } from './events.js';
import { Shutdown } from './lifecycle/shutdown.js';
import type { ShutdownHook } from './lifecycle/shutdown.js';
import { DERIVED_BUDGETS_MS } from './lifecycle/budget.js';

export interface AppContext {
  readonly config: Config;
  readonly log: EventLog;
  readonly clock: Clock;
  readonly db: Database;
  readonly auth: { readonly verifier: AuthVerifier; readonly roles?: DevRoleSource };
  /** First sign-in rules; `allowDevRole` is `config.local`. The `GET /v1/me` route provisions with it. */
  readonly signInPolicy: SignInPolicy;
  readonly shutdown: Shutdown;
  /** The collaboration host and what it needs; absent when the role has none (`api`). */
  readonly collab?: { readonly host: CollaborationHost; readonly deps: CollabDeps; readonly pageDb: Database };
  /** Every port the routes use, built here and nowhere else. */
  readonly http: HttpDeps;
  /** Test-only facilities switched on (local mode only; `run.ts` logs one line at start-up when any is). */
  readonly testFacilities: readonly ('slow-convert' | 'breaker-disabled' | 'slow-load')[];
  /** Returned without registration: lifecycle/run.ts alone registers these and HTTP/collaboration hooks (S7). */
  readonly shutdownHooks: readonly ShutdownHook[];
  /** The job queue of the roles `api` and `all`; absent for `collab`. `run` starts it after the listener is up. */
  readonly jobs?: JobRunner;
}
/** A composition that must not start although its settings are valid: a test double was handed in outside local mode. */
export interface CompositionRefusal { readonly reason: 'authorizer-stub' | 'verifier-stub'; readonly host: string; readonly port: number }
export type Composition =
  | { readonly ok: true; readonly ctx: AppContext }
  | { readonly ok: false; readonly issues: string[]; readonly problems: readonly ConfigProblem[]; readonly log: EventLog; readonly refused?: CompositionRefusal };

/**
 * Test seams: replacements for the authoriser and the verifier. Accepted only in local mode; outside it `compose` refuses to start,
 * so production always gets the database authoriser and the Descope verifier.
 */
export interface CompositionOverrides {
  readonly access?: PageAccessChecker;
  readonly verifier?: AuthVerifier;
}

const systemClock: Clock = { now: () => Date.now() };
/** Per-query limit of the authentication pool: below the host's 2 s bound on the database part of sign-in, so a hung query frees its connection. */
export const AUTH_QUERY_TIMEOUT_MS = 1500;

/** The pool's close and encompassing hook deadlines come from the one budget table. */
export function markdownPoolHook(converter: MarkdownConverter): ShutdownHook {
  return { name: 'markdown-pool', phase: 'release-jobs', deadlineMs: DERIVED_BUDGETS_MS.releaseJobs, run: () => converter.close() };
}

/** Loads configuration and constructs adapters; no global state, listener or shutdown registration occurs. */
export function compose(env?: Env, overrides: CompositionOverrides = {}): Composition {
  let config: Config;
  try { config = env ? loadConfig(env) : loadConfigFromProcessEnv(); } catch (e) {
    const problems = e instanceof ConfigError ? e.problems : [{ setting: 'configuration', rule: 'could not be loaded' }];
    return { ok: false, issues: problems.map((x) => `${x.setting}: ${x.rule}`), problems, log: createEventLog(createJsonLogger({ clock: systemClock })) };
  }
  const facilities = parseTestFacilities(env, config.local);
  if (facilities.problems.length > 0) {
    return { ok: false, issues: facilities.problems.map((x) => `${x.setting}: ${x.rule}`), problems: facilities.problems, log: createEventLog(createJsonLogger({ clock: systemClock })) };
  }
  const url = config.database.url;
  if (url === undefined) return { ok: false, issues: ['GRIMOIRE_DATABASE_URL: is required'], problems: [{ setting: 'GRIMOIRE_DATABASE_URL', rule: 'is required' }], log: createEventLog(createJsonLogger({ clock: systemClock })) };
  const log = createEventLog(createJsonLogger({ level: config.logLevel, clock: systemClock }));
  const logger = createJsonLogger({ level: config.logLevel, clock: systemClock });
  if (!config.local && (overrides.access !== undefined || overrides.verifier !== undefined)) {
    const reason = overrides.access !== undefined ? 'authorizer-stub' : 'verifier-stub';
    return { ok: false, issues: [`${reason}: refused outside local mode`], problems: [], log, refused: { reason, host: config.host, port: config.port } };
  }
  // Outside local mode the Descope verifier is the only one: there is no development verifier and no stub (R12.22). The settings
  // already refuse a missing project id or an empty domain list (exit 2); the verifier itself also throws without a project id.
  const descope = !config.local && config.descopeProjectId !== undefined ? createDescopeVerifier({
    projectId: config.descopeProjectId, baseUrl: config.descopeBaseUrl, managementKey: config.descopeManagementKey,
    logger, clock: systemClock, maxTokenLifetimeMs: config.descopeMaxTokenLifetimeSeconds * 1000,
  }) : undefined;
  const dev = config.local ? createDevAuth(config, systemClock) : undefined;
  const builtVerifier = descope ?? dev?.verifier;
  if (builtVerifier === undefined) return { ok: false, issues: ['GRIMOIRE_DESCOPE_PROJECT_ID: is required'], problems: [{ setting: 'GRIMOIRE_DESCOPE_PROJECT_ID', rule: 'is required' }], log };
  const verifier = overrides.verifier ?? builtVerifier;
  const auth: AppContext['auth'] = { verifier, ...(dev ? { roles: dev.roles } : {}) };
  const signInPolicy: SignInPolicy = { firstAdminEmails: config.firstAdminEmails, allowedEmailDomains: config.allowedEmailDomains, refusedEmailDomains: config.refusedEmailDomains, allowDevRole: config.local };
  const db = createDatabase(url);
  const collabRole = config.role !== 'api';
  const pageDb = collabRole ? createDatabase(url, { maxConnections: 4, queryTimeoutMs: config.collab.storeTimeoutMs, connectionTimeoutMs: config.collab.storeTimeoutMs }) : undefined;
  const authDb = collabRole ? createDatabase(url, { maxConnections: 4, queryTimeoutMs: AUTH_QUERY_TIMEOUT_MS, connectionTimeoutMs: AUTH_QUERY_TIMEOUT_MS }) : undefined;
  const converter = createMarkdownConverter({ maxStateBytes: config.collab.maxStateBytes, maxSeedMarkdownBytes: config.collab.seedMaxMarkdownBytes, seedTimeoutMs: config.collab.seedTimeoutMs, reseedTimeoutMs: config.collab.reseedTimeoutMs, poolSize: config.collab.convertPoolSize, closeDeadlineMs: DERIVED_BUDGETS_MS.poolClose, timeoutMs: config.collab.saveTimeoutMs, ...(facilities.slowConvert ? { testSlow: facilities.slowConvert } : {}) });
  const httpUsers = createUserStore(db, config.tenantLimits.maxUsers);
  const files = config.files === undefined ? undefined : createFileStorage(config.files);
  const http: HttpDeps = {
    config, log, clock: systemClock, users: httpUsers,
    providerBaseUrl: config.descopeProjectId === undefined ? null : descopeBaseUrl(config.descopeProjectId, config.descopeBaseUrl),
    access: overrides.access ?? createPageAccess(createAccessStore(db)),
    authorizer: createAuthorizer(createAccessStore(db)),
    provisioner: createProvisioner({ users: httpUsers, verifier, policy: signInPolicy, logger }),
    ordering: createOrdering(), converter, search: createSearchRepo(db), imports: createImportRepo(db),
    idempotency: createIdempotency(db), collections: createCollections(db), audit: createAudit(db),
    pages: createPages(db), trash: createTrash(db), revisions: createRevisions(db), admin: createAdmin(db), pageState: createPageState(db),
    attachments: createAttachments(db),
    ...(files === undefined ? {} : { files }),
    // A purge removes the objects of the attachments it deletes before it deletes any row; without a store there is nothing to remove.
    deleteFiles: deleteObjects(files),
  };
  let collab: AppContext['collab'];
  if (pageDb && authDb) {
    const users = createUserStore(authDb, config.tenantLimits.maxUsers);
    const provisioner = createProvisioner({ users, verifier, policy: signInPolicy, logger });
    const roles = dev?.roles;
    // Outside local mode: the row of the verified subject, nothing created on the WebSocket (the client calls GET /v1/me first,
    // ). Local mode: the provisioner with the development role, the same rows and rules as production otherwise.
    const resolveUser: CollabDeps['resolveUser'] = roles
      ? async (token, identity) => {
        const devRole = roles.roleOf(token);
        const r = await provisioner.signIn({ identity, ...(devRole !== undefined ? { devRole } : {}) });
        return r.kind === 'ok' ? r.user : undefined;
      }
      : (_token, identity) => users.findByDescopeId(identity.userId);
    collab = {
      host: createCollabHost(facilities.breaker ? { breaker: facilities.breaker } : {}), pageDb,
      deps: { config, logger, clock: systemClock, verifier, resolveUser, requireTenant: true, access: overrides.access ?? createPageAccess(createAccessStore(authDb)), revisions: createRevisions(pageDb), pages: withSlowLoad(createPageStore(pageDb, systemClock), facilities.slowLoad), converter },
    };
  }
  // Jobs run in the roles `api` and `all`, on the one converter pool of the process (decision 8: GRIMOIRE_CONVERT_POOL_SIZE sizes it for the editor and the import together).
  const jobs = config.role === 'collab' ? undefined : createJobRunner({ config, log, make: createJobQueue, onError: () => { log.error('jobs.failed', { name: 'queue', jobId: '-', attempt: 0, ms: 0 }); } });
  const shutdownHooks: ShutdownHook[] = [
    ...(descope ? [{ name: 'descope-keys', phase: 'stop-timers' as const, deadlineMs: DERIVED_BUDGETS_MS.stopTimers, run: () => { descope.close(); return Promise.resolve(); } }] : []),
    markdownPoolHook(converter),
    ...(jobs === undefined ? [] : [jobs.hook]),
    ...(pageDb ? [{ name: 'page-store-pool', phase: 'close-database' as const, deadlineMs: DERIVED_BUDGETS_MS.closeDatabase, run: () => pageDb.close() }] : []),
    ...(authDb ? [{ name: 'auth-pool', phase: 'close-database' as const, deadlineMs: DERIVED_BUDGETS_MS.closeDatabase, run: () => authDb.close() }] : []),
    { name: 'database-pool', phase: 'close-database', deadlineMs: DERIVED_BUDGETS_MS.closeDatabase, run: () => db.close() },
  ];
  const testFacilities: AppContext['testFacilities'] = [...(facilities.slowConvert ? ['slow-convert' as const] : []), ...(facilities.breaker ? ['breaker-disabled' as const] : []), ...(facilities.slowLoad ? ['slow-load' as const] : [])];
  return { ok: true, ctx: { config, log, clock: systemClock, db, http, auth, signInPolicy, shutdown: new Shutdown(systemClock), shutdownHooks, testFacilities, ...(jobs === undefined ? {} : { jobs }), ...(collab ? { collab } : {}) } };
}

export interface CommandComposition { readonly config: Config; readonly db: KyselyDatabase; readonly log: EventLog }
export type CommandCompositionResult = { readonly ok: true; readonly ctx: CommandComposition } | { readonly ok: false; readonly code: 1 | 2; readonly log: EventLog };
export interface MigrateOptions { readonly env?: Env; readonly dir?: string }
/** Kysely migrations first, then pg-boss's own schema, the queues of `jobQueues()` and the grants for the runtime role (the role name is fixed by the migrations), all of it under one lock: a second `migrate` waits. */
export async function migrateAdapter(db: KyselyDatabase, dir: string, migrationUrl: string, queues: readonly QueueDefinition[] = jobQueues()): Promise<{ readonly applied: string[]; readonly jobTables: number }> {
  return withMigrationLock(migrationUrl, async () => {
    const { applied } = await migrateDatabase(db, dir);
    const granted = await migratePgBoss({ connectionString: migrationUrl, database: db, runtimeRole: 'grimoire_app', queues });
    return { applied, jobTables: granted.length }; // `applied` lists only the Kysely migrations
  });
}

export function composeMigrate(options: MigrateOptions = {}): CommandCompositionResult {
  const log = createEventLog(createJsonLogger({ clock: systemClock }));
  let config: Config;
  try { config = options.env ? loadConfig(options.env, { purpose: 'migrate' }) : loadConfigFromProcessEnv({ purpose: 'migrate' }); } catch (e) {
    log.error('migrate.config_invalid', { settings: e instanceof ConfigError ? e.problems : [{ setting: 'configuration', rule: 'invalid' }] });
    return { ok: false, code: 2, log };
  }
  const url = config.database.migrationUrl;
  if (!url) { log.error('migrate.config_invalid', { settings: [{ setting: 'GRIMOIRE_DATABASE_MIGRATION_URL', rule: 'is required to run migrations' }] }); return { ok: false, code: 2, log }; }
  return { ok: true, ctx: { config, db: createDatabase(url, { maxConnections: 1 }), log } };
}

/** `grimoire tenant-adopt`: the migrator's connection, from the `migrate` settings (the runtime role may not change the tenant of a row or a tenant's name). */
export function composeTenantAdopt(options: { readonly env?: Env } = {}): CommandCompositionResult {
  const log = createEventLog(createJsonLogger({ clock: systemClock }));
  let config: Config;
  try { config = options.env ? loadConfig(options.env, { purpose: 'migrate' }) : loadConfigFromProcessEnv({ purpose: 'migrate' }); } catch (e) {
    log.error('tenant_adopt.config_invalid', { settings: e instanceof ConfigError ? e.problems : [{ setting: 'configuration', rule: 'invalid' }] });
    return { ok: false, code: 2, log };
  }
  const url = config.database.migrationUrl;
  if (!url) { log.error('tenant_adopt.config_invalid', { settings: [{ setting: 'GRIMOIRE_DATABASE_MIGRATION_URL', rule: 'is required to run tenant-adopt' }] }); return { ok: false, code: 2, log }; }
  return { ok: true, ctx: { config, db: createDatabase(url, { maxConnections: 1 }), log } };
}

/** The move itself, bound to the database adapter here like the migrations are. */
export function runTenantAdopt(db: KyselyDatabase, request: TenantAdoptRequest): Promise<TenantAdoptResult> {
  return adoptTenant(db, request);
}

export interface DbSetupComposition { readonly db: KyselyDatabase; readonly passwords: { readonly app: string; readonly migrator: string }; readonly log: EventLog }
export type DbSetupCompositionResult = { readonly ok: true; readonly ctx: DbSetupComposition } | { readonly ok: false; readonly code: 2; readonly log: EventLog };

/** `grimoire db-setup`: the administrator's connection and the two role passwords from the `db-setup` settings (no server settings, no runtime role). */
/** The set-up step itself, bound to the database adapter here like the migrations are. */
export function runDbSetup(db: KyselyDatabase, passwords: { readonly app: string; readonly migrator: string }): ReturnType<typeof setupDatabase> {
  return setupDatabase(db, passwords);
}

export function composeDbSetup(options: { readonly env?: Env } = {}): DbSetupCompositionResult {
  const log = createEventLog(createJsonLogger({ clock: systemClock }));
  let config: Config;
  try { config = options.env ? loadConfig(options.env, { purpose: 'db-setup' }) : loadConfigFromProcessEnv({ purpose: 'db-setup' }); } catch (e) {
    log.error('db_setup.config_invalid', { settings: e instanceof ConfigError ? e.problems : [{ setting: 'configuration', rule: 'invalid' }] });
    return { ok: false, code: 2, log };
  }
  const setup = config.dbSetup;
  if (setup === undefined) { log.error('db_setup.config_invalid', { settings: [{ setting: 'GRIMOIRE_DATABASE_ADMIN_URL', rule: 'is required to run db-setup' }] }); return { ok: false, code: 2, log }; }
  return { ok: true, ctx: { db: createDatabase(setup.adminUrl, { maxConnections: 1 }), passwords: { app: setup.appPassword, migrator: setup.migratorPassword }, log } };
}

export interface FilesSetupComposition { readonly setup: FilesSetupConfig; readonly allowedOrigins: readonly string[]; readonly log: EventLog }
export type FilesSetupCompositionResult = { readonly ok: true; readonly ctx: FilesSetupComposition } | { readonly ok: false; readonly code: 2; readonly log: EventLog };

/** `grimoire files-setup`: the store and the admin identity from the `files-setup` settings (no database, no runtime key). */
export function composeFilesSetup(options: { readonly env?: Env } = {}): FilesSetupCompositionResult {
  const log = createEventLog(createJsonLogger({ clock: systemClock }));
  let config: Config;
  try { config = options.env ? loadConfig(options.env, { purpose: 'files-setup' }) : loadConfigFromProcessEnv({ purpose: 'files-setup' }); } catch (e) {
    log.error('files_setup.config_invalid', { settings: e instanceof ConfigError ? e.problems : [{ setting: 'configuration', rule: 'invalid' }] });
    return { ok: false, code: 2, log };
  }
  if (config.filesSetup === undefined) { log.error('files_setup.config_invalid', { settings: [{ setting: 'GRIMOIRE_S3_ENDPOINT', rule: 'the store settings are required to run files-setup' }] }); return { ok: false, code: 2, log }; }
  return { ok: true, ctx: { setup: config.filesSetup, allowedOrigins: config.allowedOrigins, log } };
}

/**
 * The set-up step itself, bound to the store adapter here like the migrations are: in `api` mode the bucket and its
 * CORS rule are made to match the origins; in `external` mode the bucket is created and the operator's rule is checked
 * with the preflights a browser sends. Throws the adapter's `FileStorageError` when the store refuses.
 */
export async function runFilesSetup(setup: FilesSetupConfig, allowedOrigins: readonly string[]): Promise<{ readonly ok: true } | { readonly ok: false; readonly problem: string }> {
  const options = { ...setup, allowedOrigins };
  if (setup.corsMode !== 'external') { await ensureBucket(options); return { ok: true }; }
  await createBucket(options);
  return checkCors(options);
}

export function composeSeed(options: { readonly env?: Env } = {}): CommandCompositionResult {
  const log = createEventLog(createJsonLogger({ clock: systemClock }));
  let config: Config;
  try { config = options.env ? loadConfig(options.env) : loadConfigFromProcessEnv(); } catch (e) {
    log.error('seed.config_invalid', { settings: e instanceof ConfigError ? e.problems : [{ setting: 'configuration', rule: 'invalid' }] });
    return { ok: false, code: 2, log };
  }
  const url = config.database.url;
  if (!config.local || url === undefined) {
    if (config.local) log.error('seed.config_invalid', { settings: [{ setting: 'GRIMOIRE_DATABASE_URL', rule: 'is required to seed' }] });
    else log.error('seed.refused', { settings: [{ setting: 'GRIMOIRE_LOCAL', rule: 'seeding needs it set to 1 (development only); nothing was written' }] });
    return { ok: false, code: 2, log };
  }
  return { ok: true, ctx: { config, db: createDatabase(url, { maxConnections: 1 }), log } };
}

/** TEST FACILITY (local mode only, see config-env test-facilities): loading the one named page takes `ms` longer. Everything else is the store itself. */
function withSlowLoad<S extends { load(id: string): Promise<unknown> }>(store: S, slow: { readonly pageId: string; readonly ms: number } | undefined): S {
  if (slow === undefined) return store;
  const load = store.load.bind(store);
  return Object.assign(Object.create(store) as S, { load: async (id: string) => { if (id === slow.pageId) await new Promise<void>((resolve) => { setTimeout(resolve, slow.ms); }); return load(id); } });
}
