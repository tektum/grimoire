import type { Logger } from '@tektum/grimoire-core/ports/logger';

/**
 * Every log event the server may emit, with the typed fields it carries. Fields are numbers, booleans, short
 * identifiers and lists of adapter-authored messages; never requests, headers, bodies, error objects or
 * free-form text. A test fails if any file calls the logger with an event name that is not a string literal.
 */
/** A configuration problem: the setting's name and the rule it broke; never its value. */
export interface ConfigProblem {
  readonly setting: string;
  readonly rule: string;
}
export type ShutdownPhaseName = 'stop-accepting' | 'stop-timers' | 'save-pages' | 'release-jobs' | 'close-database';
export type ShutdownReason = 'SIGTERM' | 'SIGINT' | 'uncaughtException' | 'unhandledRejection';

export type ConsoleMethod = 'log' | 'info' | 'debug' | 'warn' | 'error';
export type RequestMethod = string; // an HTTP method token, as Hono reports it

/** What a job event says: the queue's name for it, the job's id, the run (1 for the first) and the milliseconds it took (0 at the start). */
export type JobEvent = { name: string; jobId: string; attempt: number; ms: number };

export interface DebugEvents {
  /** A search: how long it took and how many pages it found. Never the query text. */
  'search.query': { ms: number; results: number };
  /** The search answered from full text alone, and why. Never the query. */
  'search.semantic_fallback': { reason: string };
  'http.request': { method: RequestMethod; route: string; status: number; ms: number };
  'http.validation_failed': { route: string; issues: number };
  'console.info_output': { method: ConsoleMethod };
  'health.not_ready': { reason: 'draining' | 'database' | 'migration_pending' };
}

export interface InfoEvents {
  'http.idempotent_replay': { route: string };
  'collections.created': { collectionId: string };
  'collections.deleted': { collectionId: string };
  'collections.access_changed': { collectionId: string };
  'pages.created': { pageId: string };
  'pages.moved': { pageId: string };
  'pages.deleted': { pageId: string };
  'pages.restored': { pageId: string };
  'pages.purged': { pageId: string; count: number };
  'pages.state_reset': { pageId: string; epoch: number };
  'attachments.upload_created': { attachmentId: string; size: number };
  'attachments.completed': { attachmentId: string };
  'attachments.cleaned': { count: number };
  /** Job queue (M7). Ids, names and counts only: a payload, a key or a file name is never logged. */
  'jobs.started': JobEvent;
  'jobs.completed': JobEvent;
  'jobs.stopped': { inFlight: number };
  'import.created': { importId: string };
  'import.started': { importId: string };
  'import.progress': { importId: string; pagesDone: number; pagesTotal: number };
  'import.finished': { importId: string; ok: number; skipped: number; failed: number };
  'import.cancelled': { importId: string };
  'import.swept': { importId: string; action: string };
  'purge.completed': { pages: number; objects: number };
  /** Semantic search (M7). A page's chunks were stored: how many, how many kept their vector, how long it took. Never a text or a vector. */
  'semantic.embedded': { pageId: string; chunks: number; reused: number; ms: number };
  /** The model changed: how many pages are queued to be embedded again. `model` is the name and version, never a path. */
  'semantic.reembed_started': { model: string; pages: number };
  'admin.user_changed': { userId: string };
  'admin.group_changed': { groupId: string };
  'server.starting': { role: string; local: boolean };
  'http.listening': { host: string; port: number };
  'collab.attached': { role: string };
  'collab.listening': { host: string; port: number };
  'shutdown.started': { reason: ShutdownReason };
  'shutdown.phase_started': { phase: ShutdownPhaseName; hooks: number };
  'shutdown.hook_done': { hook: string; phase: ShutdownPhaseName; ms: number };
  'shutdown.completed': { exitCode: number };
  'migrate.nothing_pending': Record<string, never>;
  'migrate.applied': { migration: string };
  'migrate.done': { applied: number };
  'migrate.jobs_schema': { tables: number };
  'seed.done': Record<string, never>;
  /** The database is ready for `grimoire migrate`: which of the two roles were created and which only had their password set. */
  'db_setup.done': { created: readonly string[]; updated: readonly string[] };
  /** The store set-up finished: the bucket, the origins its CORS rule lists (or was checked for) and who set the rule. */
  'files_setup.done': { bucket: string; origins: readonly string[]; cors: 'api' | 'external' };
  /**
   * `grimoire tenant-adopt` moved every row of `from` into `to`: the rows moved in each tenant table, whether the `tenants` row of `to` was made, and that the row of
   * `from` is kept (the column defaults of migration 0009 still name it). Tenant ids only: never a tenant's name or domain, nor anything of a person.
   */
  'tenant_adopt.done': { from: string; to: string; tenantCreated: boolean; moved: Readonly<Record<string, number>>; sourceTenantRow: 'kept' };
}

export interface WarnEvents {
  'jobs.retrying': JobEvent;
  /** `grimoire migrate` replaced a queue made with another policy (pg-boss cannot change one): the jobs it held were dropped, and the scheduler sends the next runs again at start. */
  'jobs.queue_recreated': { queue: string; from: string; to: string; pending: number; finished: number };
  /** The stale-Markdown sweep could not convert a page (at most once an hour for each): the page's id and the converter's failure code, never content. */
  'markdown_sweep.convert_failed': { pageId: string; reason: string };
  'jobs.aborted': { name: string; jobId: string };
  /** A search that ran into its statement timeout. */
  'search.timeout': Record<string, never>;
  /** A page could not be embedded (`reason` is the embedder's code, never text) on this attempt. */
  'semantic.failed': { pageId: string; reason: string; attempt: number };
  'import.failed': { importId: string; reason: string };
  /** The archive was refused before any entry was read. `reason` is a code, never a name from the archive. */
  'import.archive_refused': { importId: string; reason: string };
  'import.item_failed': { importId: string; kind: string; reason: string };
  'http.rate_limited': { scope: 'user' | 'address' | 'route'; route: string };
  'http.auth_rejected': { reason: 'missing' | 'invalid' | 'suspended' | 'no-user' };
  /** An upload that was refused at completion and removed. The id of the attachment, never its key or name. */
  'attachments.refused': { attachmentId: string; reason: 'size_mismatch' | 'type_mismatch' | 'upload_missing' };
  'config.collab_url_missing': Record<string, never>;
  'server.local_mode_exposed': { host: string };
  /** Local mode only (refused otherwise): a test-only facility is switched on, so behaviour is deliberately not production's. */
  'server.test_facilities_active': { facilities: readonly ('slow-convert' | 'breaker-disabled' | 'slow-load')[] };
  'http.handler_rejected': { errorName: string; method: RequestMethod; route: string; status: number };
  'console.error_output': { method: ConsoleMethod };
  'shutdown.hook_timeout': { hook: string; phase: ShutdownPhaseName; deadlineMs: number };
  'shutdown.second_signal': { signal: string };
  /** An upgrade request the listener could not serve; at most one per 10 s, `suppressed` counts the others. No target, header or message. */
  'collab.upgrade_error': { reason: 'malformed-target' | 'handler-error'; errorName: string; suppressed: number };
}

export interface ErrorEvents {
  'jobs.failed': JobEvent;
  /** The embedder cannot embed, raised once for each streak. A ticket in the alarm table; `/readyz` does not depend on it. */
  'semantic.unavailable': { reason: 'model-missing' | 'model-hash-mismatch' | 'load-failed' | 'runtime-failed' };
  /** The queue could not be started after every try: the server serves without background jobs (imports, sweeps) until it is restarted. `/readyz` says so in a header. */
  'jobs.unavailable': { attempts: number };
  /** The file store did not answer (or is not configured): the operation that needed it, nothing of the request, the key or the store's message. */
  'files.unavailable': { operation: 'create' | 'complete' | 'download' | 'urls' | 'cleanup' | 'delete' | 'import-create' | 'import-start' | 'import-enqueue' | 'import-items' | 'import-source' };
  'http.request_failed': { errorName: string };
  'http.handler_error': { errorName: string; method: RequestMethod; route: string; status: number; origin?: string };
  'server.config_invalid': { settings: readonly ConfigProblem[] };
  'server.start_failed': { errorName: string; errorCode: string; host: string; port: number };
  'shutdown.hook_failed': { hook: string; phase: ShutdownPhaseName; errorName: string };
  'shutdown.forced': { reason: 'second-signal' | 'overall-deadline'; deadlineMs: number };
  'process.fault': { kind: 'uncaughtException' | 'unhandledRejection'; errorName: string };
  'migrate.config_invalid': { settings: readonly ConfigProblem[] };
  'migrate.failed': { error: string };
  'db_setup.config_invalid': { settings: readonly ConfigProblem[] };
  /** The server's own message (never a password: they are quoted by the server and not part of any text we log). */
  'db_setup.failed': { error: string };
  'seed.config_invalid': { settings: readonly ConfigProblem[] };
  'seed.refused': { settings: readonly ConfigProblem[] };
  'seed.failed': { error: string };
  'files_setup.config_invalid': { settings: readonly ConfigProblem[] };
  /** Adapter-authored text of a store refusal (never a key, a URL or a response body), or the class name of anything else. */
  'files_setup.failed': { reason: string };
  /** `external` CORS mode: the first origin, method or header the store's own rule does not allow. */
  'files_setup.cors_refused': { problem: string };
  'tenant_adopt.config_invalid': { settings: readonly ConfigProblem[] };
  /** `grimoire tenant-adopt` changed nothing, for this reason. */
  'tenant_adopt.refused': { reason: 'bad-tenant-id' | 'same-tenant' | 'source-unknown' | 'source-empty' | 'target-unnamed' | 'target-not-empty' };
  /** The database's own message (it names a table or a constraint, never a value); nothing was changed. */
  'tenant_adopt.failed': { error: string };
}

/** The only logger the server code uses. The one non-literal event name in the code base is in this file. */
export interface EventLog {
  debug<E extends keyof DebugEvents>(event: E, fields: DebugEvents[E]): void;
  info<E extends keyof InfoEvents>(event: E, fields: InfoEvents[E]): void;
  warn<E extends keyof WarnEvents>(event: E, fields: WarnEvents[E]): void;
  error<E extends keyof ErrorEvents>(event: E, fields: ErrorEvents[E]): void;
}

export function createEventLog(logger: Logger): EventLog {
  return {
    debug: (event, fields) => logger.debug(event, fields),
    info: (event, fields) => logger.info(event, fields),
    warn: (event, fields) => logger.warn(event, fields),
    error: (event, fields) => logger.error(event, fields),
  };
}

/** Only the class name of a thrown value: messages and properties of arbitrary errors may carry data. */
export function errorName(e: unknown): string {
  return e instanceof Error ? e.name : 'NonError';
}

const OUR_FRAME = /^at (?:async )?(?:[^\s()]+ \()?(?:file:\/\/)?[^\s()]*?\/((?:apps|packages)\/[^\s():]+):(\d+):\d+\)?$/;
/** The helpers that build an error on purpose (`fail`, `new ApiError`): their own line says nothing about where the request went wrong. */
const BUILDS_ERRORS = /^apps\/server\/(?:src|dist)\/http\/error\.(?:ts|js):/;
/**
 * Where an error was thrown: the first stack frame inside our code (`apps/` or `packages/`, not `node_modules`, not the helper that builds errors), as `path:line`
 * relative to the repository. Never the message (it can carry user data, and only the frames after the message header are read) and never a value. `undefined`
 * when no frame is ours.
 */
export function errorOrigin(e: unknown): string | undefined {
  if (!(e instanceof Error) || typeof e.stack !== 'string') return undefined;
  const header = e.message === '' ? e.name : `${e.name}: ${e.message}`; // the engine writes just the name for an empty message
  if (!e.stack.startsWith(header)) return undefined; // not the engine's shape: read nothing rather than a message
  for (const line of e.stack.slice(header.length).split('\n')) {
    if (line.includes('node_modules')) continue;
    const m = OUR_FRAME.exec(line.trim());
    if (m === null) continue;
    const place = m.slice(1, 3).join(':');
    if (!BUILDS_ERRORS.test(place)) return place;
  }
  return undefined;
}
