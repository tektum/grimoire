import type { Logger } from '@tektum/grimoire-core/ports/logger';

/**
 * Every log event the server may emit, with the typed fields it carries. Fields are numbers, booleans, short
 * identifiers and lists of adapter-authored messages; never requests, headers, bodies, error objects or
 * free-form text. A test fails if any file calls the logger with an event name that is not a string literal.
 */
/** A configuration problem: the setting's name and the rule it broke; never its value. */
export interface ConfigProblem { readonly setting: string; readonly rule: string }
export type ShutdownPhaseName = 'stop-accepting' | 'stop-timers' | 'save-pages' | 'release-jobs' | 'close-database';
export type ShutdownReason = 'SIGTERM' | 'SIGINT' | 'uncaughtException' | 'unhandledRejection';

export type ConsoleMethod = 'log' | 'info' | 'debug' | 'warn' | 'error';
export type RequestMethod = string; // an HTTP method token, as Hono reports it

export interface DebugEvents {
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
}

export interface WarnEvents {
  'http.rate_limited': { scope: 'user' | 'address' | 'route'; route: string };
  'http.auth_rejected': { reason: 'missing' | 'invalid' | 'suspended' | 'no-user' };
  /** Sign-in or a returning-user check was refused: the fixed reason of the provisioner, never an email or a domain. */
  'users.refused': { reason: 'domain-not-allowed' | 'email-taken' | 'profile-unavailable' | 'profile-missing' };
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
  'http.request_failed': { errorName: string };
  'http.handler_error': { errorName: string; method: RequestMethod; route: string; status: number };
  'server.config_invalid': { settings: readonly ConfigProblem[] };
  'server.start_failed': { errorName: string; errorCode: string; host: string; port: number };
  'shutdown.hook_failed': { hook: string; phase: ShutdownPhaseName; errorName: string };
  'shutdown.forced': { reason: 'second-signal' | 'overall-deadline'; deadlineMs: number };
  'process.fault': { kind: 'uncaughtException' | 'unhandledRejection'; errorName: string };
  'migrate.config_invalid': { settings: readonly ConfigProblem[] };
  'migrate.failed': { error: string };
  'seed.config_invalid': { settings: readonly ConfigProblem[] };
  'seed.refused': { settings: readonly ConfigProblem[] };
  'seed.failed': { error: string };
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
