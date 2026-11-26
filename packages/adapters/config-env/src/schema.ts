import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { isDescopeProjectId } from '@tektum/grimoire-core/ports/auth-verifier';
import { parseVersion } from '@tektum/grimoire-core/version';
import type { Config, FilesConfig, FilesSetupConfig } from '@tektum/grimoire-core/ports/config';

const P = 'GRIMOIRE_';
const MAX_INT = Number.MAX_SAFE_INTEGER;
const HTTP = /^https?$/;

// Every schema sets its own messages: zod's defaults can echo the received value, which may be a secret.
const msg = (m: string) => ({ error: () => m });
/** Message for an absent variable (input undefined) versus a malformed one; never reads the value itself. */
const msgOr = (missing: string | undefined, bad: string) => ({
  error: (iss: { readonly input?: unknown }) => (iss.input === undefined && missing !== undefined ? missing : bad),
});

const ASCII_RULE = 'must contain only printable ASCII characters';
const PRINTABLE = /^[\x21-\x7E]+$/;
// Only a space directly around a list comma is trimmed; every other character must be 0x21-0x7E.
const printableList = (v: string): boolean => v.split(',').every((i) => {
  const t = i.replace(/^ +| +$/g, '');
  return t === '' || PRINTABLE.test(t);
});

/**
 * Wraps a value schema: absent input gets `missing` (when given); then the character-set rule runs first
 * and before any other rule (its message never echoes the value); then `schema` runs.
 */
const field = <T extends z.ZodType<unknown, string>>(schema: T, missing?: string, list = false) => {
  const piped = z.string(msgOr(missing, ASCII_RULE))
    .refine((v) => (list ? printableList(v) : PRINTABLE.test(v)), msg(ASCII_RULE))
    .pipe(schema);
  return missing === undefined ? piped.optional() : piped;
};

/** Digits only (z.coerce.number alone would accept signs, exponents and hex), then an integer in range. */
const int = (min: number, max: number) => {
  const rule = max === MAX_INT ? `must be an integer >= ${min}` : `must be an integer from ${min} to ${max}`;
  return z.string(msg(rule)).regex(/^\d+$/, msg(rule))
    .transform(Number).pipe(z.number(msg(rule)).int(msg(rule)).min(min, msg(rule)).max(max, msg(rule)));
};

/** Five fields of digits, `*`, `/`, `,` and `-`: UTC cron as the job queue reads it. Not a full parse: the queue refuses what is still wrong when it registers the schedule. */
const CRON_RULE = 'must be a cron schedule of five fields (minute hour day month weekday, UTC)';
const cron = z.string(msg(CRON_RULE)).regex(/^[0-9*/,-]+( [0-9*/,-]+){4}$/, msg(CRON_RULE));
/** A cron value has spaces inside it, which `field` does not allow in a single value; the characters are checked by the rule itself. */
const cronField = z.string(msg(CRON_RULE)).pipe(cron).optional();

/** A decimal from 0 to 1 written in digits and one point, nothing else (no sign, exponent or hex): a similarity floor. */
const UNIT_RULE = 'must be a number from 0 to 1, written in digits (for example 0.25)';
const unit = z.string(msg(UNIT_RULE)).regex(/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/, msg(UNIT_RULE)).transform(Number);

const PORT_MAX = 65535;
const HOST_RULE = 'must be an IPv4 or IPv6 address literal (no hostname, no port)';
const ENV_RULE = 'must be 1 to 32 characters: lowercase letters, digits and hyphens, starting with a letter';
/** Whether an operand already satisfies its own field rule (integer within its range). */
const valid = (x: unknown, min: number, max: number): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;

const text = z.string().refine((v) => v.trim() !== '', msg('must not be blank'));
const list = <T extends z.ZodType<string, string>>(item: T, rule: string) =>
  z.string(msg(rule)).transform((v) => v.split(',').map((s) => s.trim()).filter((s) => s !== ''))
    .pipe(z.array(item).min(1, msg(rule)));

const VERSION_RULE = 'must be a version of three dot-separated numbers without leading zeros';
const httpRule = 'must be an http:// or https:// URL';
const httpUrl = z.url({ protocol: HTTP, ...msg(httpRule) });
const descopeBaseUrl = httpUrl.superRefine((v, ctx) => {
  if (!URL.canParse(v)) return; // the URL check above already reports it; do not throw from here
  const url = new URL(v);
  if (url.username !== '' || url.password !== '') ctx.addIssue({ code: 'custom', message: 'must not contain username or password credentials' });
});
const dbRule = 'must be a postgres:// or postgresql:// URL';
const dbPassword = z.string(msg('must be a string')).min(16, msg('must be at least 16 characters'));
const dbUrl = z.url({ protocol: /^postgres(?:ql)?$/, ...msg(dbRule) }).regex(/^postgres(?:ql)?:\/\//, msg(dbRule));
const originRule = 'must be a comma list of scheme://host[:port] origins with no path and no wildcard';
// zod has no "origin" format: a URL whose origin equals itself rules out paths, queries and wildcards.
const origin = z.url({ protocol: HTTP, ...msg(originRule) })
  .refine((v) => !v.includes('*') && URL.canParse(v) && new URL(v).origin.toLowerCase() === v.toLowerCase(), msg(originRule));
const ipRule = 'must be a comma list of IP addresses or CIDR ranges';
const ipOrCidr = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()], msg(ipRule));
// Intentionally zod's stricter z.email: no unicode, quoted local parts, IP-literal domains, one-letter TLDs, dot errors.
const emailRule = 'must be a comma list of email addresses';
const email = z.email(msg(emailRule));
const domainRule = 'must be a comma list of lowercase host names without @';
// Zod validates the host grammar; sending it through its email parser supplies the missing local part.
const domain = z.string(msg(domainRule)).transform((v, ctx) => {
  const result = z.email(msg(emailRule)).safeParse(`grimoire@${v}`);
  if (!result.success) {
    ctx.addIssue({ code: 'custom', message: domainRule });
    return z.NEVER;
  }
  return v.toLowerCase();
});

type Purpose = 'server' | 'migrate' | 'files-setup' | 'db-setup';
type Raw = Readonly<Record<string, string>>;
type S3Required = 'ENDPOINT' | 'BUCKET';
const S3_ANY = ['ENDPOINT', 'PUBLIC_ENDPOINT', 'BUCKET', 'ACCESS_KEY', 'SECRET_KEY', 'REGION', 'ADDRESSING_STYLE'] as const;
const SERVER_ONLY = 'is required to run the server';
/** What only the db-setup step holds: the administrator connection and the role passwords. */
const DB_SETUP_HELD = ['GRIMOIRE_DATABASE_ADMIN_URL', 'GRIMOIRE_DB_APP_PASSWORD', 'GRIMOIRE_DB_MIGRATOR_PASSWORD', 'GRIMOIRE_DB_OPS_PASSWORD'] as const;
const SETUP_ONLY = 'is required to run files-setup';

const MIME_RULE = 'must be a comma list of lowercase type/subtype names';
const FORBIDDEN_TYPES = ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/javascript', 'application/javascript'];
// The 17 types of R9.14: images, documents, archives and video that a browser never runs inline.
const DEFAULT_TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'application/pdf', 'text/plain', 'text/csv', 'text/markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip', 'video/mp4', 'video/webm', 'video/quicktime',
];
// Script and XML families as well as the exact names: a browser runs (or renders as XML, with scripts) every one of them inline.
const executableType = (t: string): boolean => FORBIDDEN_TYPES.includes(t) || /(^|\/)(x-)?(java|ecma)script$|^text\/(javascript1\.[0-5]|jscript|livescript)$|[+/]xml$/.test(t);
const mime = z.string(msg(MIME_RULE)).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/, msg(MIME_RULE));


const fieldSchema = (purpose: Purpose) => z.object({
  GRIMOIRE_LOCAL: field(z.enum(['0', '1'], msg('must be 0 or 1'))).default('0'),
  GRIMOIRE_ROLE: field(z.enum(['all', 'api', 'collab'], msg('must be one of: all, api, collab'))).default('all'),
  GRIMOIRE_HOST: field(z.union([z.ipv4(msg(HOST_RULE)), z.ipv6(msg(HOST_RULE))], msg(HOST_RULE))).default('127.0.0.1'),
  GRIMOIRE_PORT: field(int(1, PORT_MAX)).default(8080),
  GRIMOIRE_COLLAB_PORT: field(int(1, PORT_MAX)),
  GRIMOIRE_LOG_LEVEL: field(z.enum(['debug', 'info', 'warn', 'error'], msg('must be one of: debug, info, warn, error'))).default('info'),
  // The environment (the stage) the process runs in: written on every log line as `env`. The infrastructure sets it; a local run is `local`.
  GRIMOIRE_ENV: field(z.string(msg(ENV_RULE)).regex(/^[a-z][a-z0-9-]{0,31}$/, msg(ENV_RULE))).default('local'),
  GRIMOIRE_DATABASE_URL: field(dbUrl, purpose === 'server' ? SERVER_ONLY : undefined),
  GRIMOIRE_DATABASE_MIGRATION_URL: field(dbUrl, purpose === 'migrate' ? 'is required to run migrations' : undefined),
  // The operator role's connection (docs/tenancy.md section 3.2): the server's composition requires it (the commands do not), and nothing replaces it with the runtime connection.
  GRIMOIRE_DATABASE_OPS_URL: field(dbUrl),
  GRIMOIRE_DATABASE_ADMIN_URL: field(dbUrl, purpose === 'db-setup' ? 'is required to run db-setup' : undefined),
  GRIMOIRE_DB_APP_PASSWORD: field(dbPassword, purpose === 'db-setup' ? 'is required to run db-setup' : undefined),
  GRIMOIRE_DB_MIGRATOR_PASSWORD: field(dbPassword, purpose === 'db-setup' ? 'is required to run db-setup' : undefined),
  GRIMOIRE_DB_OPS_PASSWORD: field(dbPassword, purpose === 'db-setup' ? 'is required to run db-setup' : undefined),
  GRIMOIRE_DESCOPE_PROJECT_ID: field(text),
  GRIMOIRE_DESCOPE_BASE_URL: field(descopeBaseUrl),
  GRIMOIRE_DESCOPE_MAX_TOKEN_LIFETIME_SECONDS: field(int(1, 86400)).default(86400),
  GRIMOIRE_DESCOPE_MANAGEMENT_KEY: field(text),
  GRIMOIRE_DEV_TOKEN_SECRET: field(z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, msg('must be 16 to 128 characters of A-Z a-z 0-9 _ -'))),
  GRIMOIRE_LOCAL_ALLOW_NON_LOOPBACK: field(z.enum(['0', '1'], msg('must be 0 or 1'))).default('0'),
  GRIMOIRE_ALLOWED_ORIGINS: field(list(origin, originRule), purpose === 'server' ? SERVER_ONLY : purpose === 'files-setup' ? SETUP_ONLY : undefined, true),
  GRIMOIRE_TRUSTED_PROXY: field(list(ipOrCidr, ipRule), undefined, true).default([]),
  GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: field(int(1, MAX_INT)).default(45000),
  GRIMOIRE_COLLAB_MAX_PAYLOAD_BYTES: field(int(1, MAX_INT)).default(1048576),
  GRIMOIRE_COLLAB_MAX_STATE_BYTES: field(int(1, MAX_INT)).default(1_000_000),
  GRIMOIRE_SEED_MAX_MARKDOWN_BYTES: field(int(1, 16_777_216)).default(131_072),
  GRIMOIRE_SEED_TIMEOUT_MS: field(int(100, 60_000)).default(10_000),
  GRIMOIRE_RESEED_TIMEOUT_MS: field(int(1000, 600_000)).default(30000),
  GRIMOIRE_SAVE_TIMEOUT_MS: field(int(100, 120_000)).default(10000),
  GRIMOIRE_CONVERT_POOL_SIZE: field(int(1, 16)).default(2),
  GRIMOIRE_COLLAB_STATE_WARN_PERCENT: field(int(1, 99)).default(80),
  GRIMOIRE_COLLAB_MESSAGES_PER_WINDOW: field(int(1, MAX_INT)).default(300),
  GRIMOIRE_COLLAB_RATE_WINDOW_SECONDS: field(int(1, MAX_INT)).default(10),
  GRIMOIRE_COLLAB_MAX_CONNECTIONS_PER_PAGE: field(int(1, MAX_INT)).default(100),
  GRIMOIRE_COLLAB_MAX_CONNECTIONS: field(int(1, MAX_INT)).default(500),
  GRIMOIRE_COLLAB_MAX_OPEN_DOCUMENTS: field(int(1, MAX_INT)).default(200),
  GRIMOIRE_COLLAB_MEMORY_LIMIT_BYTES: field(int(1, MAX_INT)).default(1073741824),
  GRIMOIRE_COLLAB_MEMORY_GUARD_PERCENT: field(int(1, 99)).default(80),
  GRIMOIRE_COLLAB_IDLE_UNLOAD_SECONDS: field(int(1, MAX_INT)).default(60),
  GRIMOIRE_COLLAB_CONNECT_ATTEMPTS_PER_WINDOW: field(int(1, MAX_INT)).default(50),
  GRIMOIRE_COLLAB_CONNECT_WINDOW_SECONDS: field(int(1, MAX_INT)).default(60),
  GRIMOIRE_COLLAB_BAN_SECONDS: field(int(1, MAX_INT)).default(300),
  GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS_PER_ADDRESS: field(int(1, MAX_INT)).default(10),
  GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS: field(int(1, MAX_INT)).default(500),
  GRIMOIRE_COLLAB_PREAUTH_TIMEOUT_SECONDS: field(int(1, 60)).default(5),
  GRIMOIRE_COLLAB_MAX_SOCKETS_PER_USER: field(int(1, MAX_INT)).default(20),
  GRIMOIRE_COLLAB_MAX_DOCUMENTS_PER_USER: field(int(1, MAX_INT)).default(50),
  GRIMOIRE_COLLAB_BYTES_PER_SECOND_PER_USER: field(int(1, MAX_INT)).default(2097152),
  GRIMOIRE_COLLAB_MAX_UNAUTH_QUEUED_BYTES: field(int(1, MAX_INT)).default(67_108_864),
  GRIMOIRE_COLLAB_DEBOUNCE_MS: field(int(1, MAX_INT)).default(3000),
  GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: field(int(1, MAX_INT)).default(10000),
  GRIMOIRE_COLLAB_STORE_RETRY_BASE_MS: field(int(1, MAX_INT)).default(1000),
  GRIMOIRE_COLLAB_STORE_RETRY_MAX_MS: field(int(1, MAX_INT)).default(30000),
  GRIMOIRE_COLLAB_STORE_TIMEOUT_MS: field(int(1, MAX_INT)).default(2000),
  GRIMOIRE_COLLAB_RECHECK_SECONDS: field(int(1, 600)).default(60),
  // S3 is parsed and validated but not yet used (R2.27). No default for the addressing style: a set
  // variable must stay distinguishable from an absent one for the all-or-nothing rule.
  GRIMOIRE_S3_ENDPOINT: field(httpUrl, purpose === 'files-setup' ? SETUP_ONLY : undefined),
  GRIMOIRE_S3_PUBLIC_ENDPOINT: field(httpUrl),
  GRIMOIRE_S3_BUCKET: field(text, purpose === 'files-setup' ? SETUP_ONLY : undefined),
  GRIMOIRE_S3_ACCESS_KEY: field(text),
  GRIMOIRE_S3_SECRET_KEY: field(text),
  GRIMOIRE_S3_REGION: field(text),
  GRIMOIRE_S3_ADDRESSING_STYLE: field(z.enum(['path', 'virtual'], msg('must be one of: path, virtual'))),
  GRIMOIRE_S3_ADMIN_ACCESS_KEY: field(text, purpose === 'files-setup' ? SETUP_ONLY : undefined),
  GRIMOIRE_S3_ADMIN_SECRET_KEY: field(text, purpose === 'files-setup' ? SETUP_ONLY : undefined),
  GRIMOIRE_S3_CREATE_ONLY_HEADER: field(z.enum(['if-none-match', 'x-goog-if-generation-match'], msg('must be one of: if-none-match, x-goog-if-generation-match'))).default('if-none-match'),
  GRIMOIRE_S3_CORS_MODE: field(z.enum(['api', 'external'], msg('must be one of: api, external'))).default('api'),
  // The size of what one import takes (an export in parts is several zips): sized from a real export of 94 GB of which 32 GB is video, with room (decision 179). The first four are what a person
  // may send; the quota is what a workspace may hold in uploads that are not over (their zips are in the store until the import ends).
  GRIMOIRE_IMPORT_MAX_ZIP_BYTES: field(int(1, MAX_INT)).default(34_359_738_368),
  GRIMOIRE_IMPORT_MAX_ZIPS: field(int(1, 64)).default(8),
  GRIMOIRE_IMPORT_MAX_TOTAL_BYTES: field(int(1, MAX_INT)).default(68_719_476_736),
  GRIMOIRE_IMPORT_STAGED_QUOTA_BYTES: field(int(1, MAX_INT)).default(161_061_273_600),
  GRIMOIRE_IMPORT_MAX_ENTRIES: field(int(1, MAX_INT)).default(100_000),
  GRIMOIRE_IMPORT_MAX_UNCOMPRESSED_BYTES: field(int(1, MAX_INT)).default(103_079_215_104),
  GRIMOIRE_IMPORT_MAX_RATIO: field(int(1, MAX_INT)).default(100),
  // The largest file of a zip, which an attachment of an import may be: not the editor's upload limit (GRIMOIRE_FILES_MAX_BYTES). A file is sent to the store as a stream, so none is held in memory.
  GRIMOIRE_IMPORT_MAX_ENTRY_BYTES: field(int(1, MAX_INT)).default(2_147_483_648),
  GRIMOIRE_IMPORT_MAX_TABLE_BYTES: field(int(1, MAX_INT)).default(262_144),
  GRIMOIRE_IMPORT_ALLOW_NESTED_ZIPS: field(z.enum(['0', '1'], msg('must be 0 or 1'))).default('0'),
  GRIMOIRE_IMPORT_FETCH_REMOTE_IMAGES: field(z.enum(['0', '1'], msg('must be 0 or 1'))).default('1'),
  GRIMOIRE_IMPORT_REMOTE_MAX_IMAGES: field(int(1, MAX_INT)).default(200),
  GRIMOIRE_IMPORT_REMOTE_MAX_BYTES: field(int(1, MAX_INT)), // unset: 20 MiB, or the upload limit when that is smaller (below)
  GRIMOIRE_IMPORT_REMOTE_TIMEOUT_SECONDS: field(int(1, 60)).default(10),
  GRIMOIRE_IMPORT_REMOTE_TOTAL_SECONDS: field(int(10, 3600)).default(300),
  GRIMOIRE_IMPORT_CONCURRENCY: field(int(1, 16)).default(2),
  // At most 24 hours: the job queue refuses a longer expiry (pg-boss `MAX_EXPIRATION_HOURS`), which would fail `migrate` and the start of the server.
  GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS: field(int(1, 86_400)).default(900),
  // At most 1500: the share of the 2 s `release-jobs` shutdown phase that is left for the job queue's stop (apps/server `JOBS_STOP_GRACE_MAX_MS`, which a test keeps equal).
  GRIMOIRE_JOBS_STOP_GRACE_MS: field(int(1, 1500)).default(1500),
  GRIMOIRE_JOBS_PURGE_CRON: cronField.default('17 3 * * *'),
  GRIMOIRE_JOBS_UPLOAD_CLEANUP_CRON: cronField.default('*/15 * * * *'),
  GRIMOIRE_JOBS_REVISION_CRON: cronField.default('47 3 * * *'),
  GRIMOIRE_JOBS_SWEEP_CRON: cronField.default('*/5 * * * *'),
  GRIMOIRE_SEARCH_STATEMENT_TIMEOUT_MS: field(int(100, 30_000)).default(3000),
  GRIMOIRE_SEMANTIC_SEARCH: field(z.enum(['on', 'off'], msg('must be on or off'))).default('on'),
  GRIMOIRE_SEMANTIC_MODEL: field(z.enum(['multilingual-e5-base', 'multilingual-e5-small'], msg('must be one of: multilingual-e5-base, multilingual-e5-small'))).default('multilingual-e5-base'),
  GRIMOIRE_SEMANTIC_MODEL_DIR: field(z.string(msg('must be an absolute path')).refine((v) => v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v), msg('must be an absolute path'))).default('/app/models'),
  GRIMOIRE_SEMANTIC_THREADS: field(int(1, 4)).default(2),
  GRIMOIRE_SEMANTIC_DEBOUNCE_SECONDS: field(int(5, 3600)).default(30),
  GRIMOIRE_SEMANTIC_SWEEP_SECONDS: field(int(5, 600)).default(15),
  GRIMOIRE_SEMANTIC_MAX_CHUNKS_PER_MINUTE: field(int(1, 100_000)).default(600),
  GRIMOIRE_SEMANTIC_QUERY_TIMEOUT_MS: field(int(100, 10_000)).default(1500),
  GRIMOIRE_SEMANTIC_MIN_SIMILARITY: field(unit).default(0),
  GRIMOIRE_SEMANTIC_CANDIDATES: field(int(10, 500)).default(100),
  GRIMOIRE_FILES_MAX_BYTES: field(int(1, MAX_INT)).default(26_214_400),
  GRIMOIRE_FILES_ALLOWED_TYPES: field(list(mime, MIME_RULE), undefined, true).default(DEFAULT_TYPES),
  GRIMOIRE_FILES_PENDING_MAX_PER_USER: field(int(1, MAX_INT)).default(10),
  GRIMOIRE_REQUIRE_HANDSHAKE: field(z.enum(['0', '1'], msg('must be 0 or 1'))).default('0'),
  GRIMOIRE_MIN_CLIENT_VERSION: field(z.string(msg(VERSION_RULE)).refine((v) => parseVersion(v) !== null, msg(VERSION_RULE))).default('0.0.0'),
  GRIMOIRE_HTTP_USER_LIMIT_PER_MINUTE: field(int(1, MAX_INT)).default(1000),
  GRIMOIRE_HTTP_ADDRESS_LIMIT_PER_MINUTE: field(int(1, MAX_INT)).default(60),
  GRIMOIRE_HTTP_ADDRESS_CEILING_PER_MINUTE: field(int(1, MAX_INT)).default(6000),
  GRIMOIRE_TENANT_MAX_USERS: field(int(1, MAX_INT)).default(1000),
  GRIMOIRE_TENANT_MAX_STORAGE_BYTES: field(int(1, MAX_INT)).default(10 * 1024 ** 3),
  GRIMOIRE_TENANT_MAX_PAGES: field(int(1, MAX_INT)).default(50_000),
  GRIMOIRE_PUBLIC_API_URL: field(httpUrl),
  GRIMOIRE_WEB_ROOT: field(z.string(msg('must be an absolute path')).refine((v) => v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v), msg('must be an absolute path'))),
  GRIMOIRE_PUBLIC_COLLAB_URL: field(z.url({ protocol: /^(?:https?|wss?)$/, ...msg('must be an http(s):// or ws(s):// URL') })),
  GRIMOIRE_FIRST_ADMIN_EMAILS: field(list(email.transform((v) => v.toLowerCase()), emailRule), undefined, true).transform((v) => [...new Set(v ?? [])]).default([]),
  GRIMOIRE_REFUSED_EMAIL_DOMAINS: field(list(domain, domainRule), undefined, true).transform((v) => [...new Set(v ?? [])]).default([]),
  GRIMOIRE_ALLOWED_EMAIL_DOMAINS: field(list(domain, domainRule), undefined, true).transform((v) => [...new Set(v ?? [])]).default([]),
});

/**
 * Cross-field rules (R2.43 refusals and the pairwise rules). `when` makes them run even when other
 * variables failed; a rule whose operand is not a validated number is skipped
 * (that field is already reported). Presence ("is set") is read from the raw strings, which are only tested
 * for existence, never parsed, so these rules cannot throw.
 */
const always = (): boolean => true;
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
/** Loopback by `net.BlockList` (which also matches IPv4-mapped IPv6); an unparsable host is not loopback. */
const isLoopback = (host: string): boolean => (isIP(host) === 4 ? LOOPBACK.check(host, 'ipv4') : isIP(host) === 6 && LOOPBACK.check(host, 'ipv6'));
/** A bucket the AWS SDK puts in the host (virtual addressing): one DNS label of 3 to 63 characters (a dot or an upper case letter sends it path style), and never on an IP address. */
const virtualHostable = (bucket: string, endpoint: URL): boolean =>
  isIP(endpoint.hostname.replace(/^\[|\]$/g, '')) === 0 && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket);

/** The origin browsers send file requests to: with virtual addressing the bucket is part of the host (where the SDK can put it there), so it is part of the origin. */
const publicOriginOf = (publicEndpoint: string, bucket: string, addressing: 'path' | 'virtual'): string => {
  const url = new URL(publicEndpoint);
  if (addressing === 'virtual' && virtualHostable(bucket, url)) url.hostname = `${bucket}.${url.hostname}`;
  return url.origin;
};

/** Whether the public store endpoint shares an origin with an allowed app origin (a stored file would then run as the app). */
const publicEndpointIsAnAppOrigin = (raw: Raw): boolean => {
  const endpoint = raw['GRIMOIRE_S3_PUBLIC_ENDPOINT'] ?? raw['GRIMOIRE_S3_ENDPOINT']; // the one Config.files will use
  if (endpoint === undefined || !URL.canParse(endpoint)) return false; // the URL rule reports a bad value
  const bucket = raw['GRIMOIRE_S3_BUCKET'];
  const storeOrigin = (bucket === undefined ? new URL(endpoint).origin : publicOriginOf(endpoint, bucket, raw['GRIMOIRE_S3_ADDRESSING_STYLE'] === 'virtual' ? 'virtual' : 'path')).toLowerCase();
  return (raw['GRIMOIRE_ALLOWED_ORIGINS'] ?? '').split(',').some((o) => o.trim().toLowerCase() === storeOrigin);
};

const envSchema = (purpose: Purpose, raw: Raw) => {
  const set = (name: string): boolean => raw[name] !== undefined;
  const s3Missing = (n: S3Required) => ({
    path: [`GRIMOIRE_S3_${n}`], when: always,
    error: () => `is required when any ${P}S3_* variable is set`,
  });
  const s3Any = (): boolean => S3_ANY.some((n) => set(`GRIMOIRE_S3_${n}`));
  const server = purpose === 'server';
  const local = raw['GRIMOIRE_LOCAL'] === '1';
  return fieldSchema(purpose)
    .refine(() => !(server && local && set('GRIMOIRE_DESCOPE_PROJECT_ID')), {
      path: ['GRIMOIRE_LOCAL'], when: always,
      error: () => `must not be 1 (development tokens) together with ${P}DESCOPE_PROJECT_ID: unset one of them`,
    })
    .refine(() => !(server && local && !set('GRIMOIRE_DEV_TOKEN_SECRET')), {
      // Reported on GRIMOIRE_LOCAL, and worded without "NAME: value" shapes: the log scrubber redacts those next to a name that contains SECRET.
      path: ['GRIMOIRE_LOCAL'], when: always,
      error: () => `needs ${P}DEV_TOKEN_SECRET to be set, at 16 or more characters (\`make up\` generates one in .env)`,
    })
    .refine(() => !(server && local && raw['GRIMOIRE_LOCAL_ALLOW_NON_LOOPBACK'] !== '1' && !isLoopback(raw['GRIMOIRE_HOST'] ?? '127.0.0.1')), {
      path: ['GRIMOIRE_HOST'], when: always,
      error: () => `is not a loopback address in local mode (development tokens): bind 127.0.0.1 or ::1, or set ${P}LOCAL_ALLOW_NON_LOOPBACK=1 where the network is trusted`,
    })
    .refine(() => !set('GRIMOIRE_DESCOPE_PROJECT_ID') || isDescopeProjectId(String(raw['GRIMOIRE_DESCOPE_PROJECT_ID'])), {
      path: ['GRIMOIRE_DESCOPE_PROJECT_ID'], when: always,
      error: () => 'must be letters and digits only (1 to 128 characters), the same rule the token verifier applies',
    })
    .refine(() => !(server && !local && !set('GRIMOIRE_DESCOPE_PROJECT_ID')), {
      path: ['GRIMOIRE_DESCOPE_PROJECT_ID'], when: always,
      error: () => `is required in non-local mode (set it, or set ${P}LOCAL=1 for development)`,
    })
    .refine((v) => {
      if (server && !local && typeof v.GRIMOIRE_DESCOPE_BASE_URL === 'string' && URL.canParse(v.GRIMOIRE_DESCOPE_BASE_URL)) {
        return new URL(v.GRIMOIRE_DESCOPE_BASE_URL).protocol === 'https:';
      }
      return true;
    }, {
      path: ['GRIMOIRE_DESCOPE_BASE_URL'], when: always,
      error: () => 'must use https outside local mode',
    })
    .refine(() => !(server && !local && !set('GRIMOIRE_ALLOWED_EMAIL_DOMAINS')), {
      path: ['GRIMOIRE_ALLOWED_EMAIL_DOMAINS'], when: always,
      error: () => 'must name at least one email domain outside local mode; never treat an empty list as any domain',
    })
    .refine(() => !(set('GRIMOIRE_DESCOPE_BASE_URL') && !set('GRIMOIRE_DESCOPE_PROJECT_ID')), {
      path: ['GRIMOIRE_DESCOPE_BASE_URL'], when: always,
      error: () => `requires ${P}DESCOPE_PROJECT_ID`,
    })
    .refine(() => !(set('GRIMOIRE_DESCOPE_MANAGEMENT_KEY') && !set('GRIMOIRE_DESCOPE_PROJECT_ID')), {
      path: ['GRIMOIRE_DESCOPE_MANAGEMENT_KEY'], when: always,
      error: () => `requires ${P}DESCOPE_PROJECT_ID`,
    })
    .refine((v) => {
      // A failed field keeps its raw string (or an out-of-range number) in `v`; only operands that passed
      // their own range rule are compared; a bad operand is reported by its own field alone.
      const p: unknown = v.GRIMOIRE_COLLAB_PORT;
      const h: unknown = v.GRIMOIRE_PORT;
      return !valid(p, 1, PORT_MAX) || !valid(h, 1, PORT_MAX) || p !== h;
    }, { path: ['GRIMOIRE_COLLAB_PORT'], when: always, error: () => `must differ from ${P}PORT` })
    .refine((v) => {
      const d: unknown = v.GRIMOIRE_COLLAB_DEBOUNCE_MS;
      const m: unknown = v.GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS;
      return !valid(d, 1, MAX_INT) || !valid(m, 1, MAX_INT) || d <= m;
    }, { path: ['GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS'], when: always, error: () => `must be >= ${P}COLLAB_DEBOUNCE_MS` })
    .refine((v) => {
      // Shutdown waits for stores that may each take up to the store timeout: a timeout at or past the deadline lets shutdown overrun it.
      const t: unknown = v.GRIMOIRE_COLLAB_STORE_TIMEOUT_MS;
      const d: unknown = v.GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS;
      return !valid(t, 1, MAX_INT) || !valid(d, 1, MAX_INT) || t < d;
    }, { path: ['GRIMOIRE_COLLAB_STORE_TIMEOUT_MS'], when: always, error: () => `must be smaller than ${P}SHUTDOWN_SAVE_DEADLINE_MS` })
    .refine((v) => {
      // A save is a conversion followed by a store: one that is running when the server stops has to end inside the shutdown save deadline, both parts at their limits.
      // (When the store timeout alone is already not below the deadline, that rule reports it; this one stays quiet so one cause gives one message.)
      const t: unknown = v.GRIMOIRE_SAVE_TIMEOUT_MS;
      const s: unknown = v.GRIMOIRE_COLLAB_STORE_TIMEOUT_MS;
      const d: unknown = v.GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS;
      return !valid(t, 100, 120_000) || !valid(s, 1, MAX_INT) || !valid(d, 1, MAX_INT) || s >= d || t + s < d;
    }, { path: ['GRIMOIRE_SAVE_TIMEOUT_MS'], when: always, error: () => `plus ${P}COLLAB_STORE_TIMEOUT_MS must be smaller than ${P}SHUTDOWN_SAVE_DEADLINE_MS` })
    .refine(() => !s3Any() || set('GRIMOIRE_S3_ENDPOINT'), s3Missing('ENDPOINT'))
    .refine(() => !s3Any() || set('GRIMOIRE_S3_BUCKET'), s3Missing('BUCKET'))
    // The runtime key pair is both or neither. Neither: the AWS default credential chain (a task role on AWS). files-setup uses the admin key and never the runtime key.
    .refine(() => purpose === 'files-setup' || set('GRIMOIRE_S3_ACCESS_KEY') === set('GRIMOIRE_S3_SECRET_KEY'), {
      path: [set('GRIMOIRE_S3_ACCESS_KEY') ? 'GRIMOIRE_S3_SECRET_KEY' : 'GRIMOIRE_S3_ACCESS_KEY'], when: always,
      error: () => `is required when the other ${P}S3_ACCESS_KEY or ${P}S3_SECRET_KEY is set (or unset both to use the AWS default credential chain)`,
    })
    .refine(() => set('GRIMOIRE_S3_ADMIN_ACCESS_KEY') === set('GRIMOIRE_S3_ADMIN_SECRET_KEY'), {
      path: [set('GRIMOIRE_S3_ADMIN_ACCESS_KEY') ? 'GRIMOIRE_S3_ADMIN_SECRET_KEY' : 'GRIMOIRE_S3_ADMIN_ACCESS_KEY'], when: always,
      error: () => `is required when the other ${P}S3_ADMIN_* key is set`,
    })
    // The running server never holds the admin key; only a local development stack may pass it (the test harness does).
    // Serving the web client needs what its response headers and its configuration are made from: the public API and live editing addresses and the file store.
    .refine(() => !(server && set('GRIMOIRE_WEB_ROOT') && !set('GRIMOIRE_PUBLIC_API_URL')), {
      path: ['GRIMOIRE_PUBLIC_API_URL'], when: always,
      error: () => `is required when ${P}WEB_ROOT is set (the web client is configured with it)`,
    })
    .refine(() => !(server && set('GRIMOIRE_WEB_ROOT') && !set('GRIMOIRE_PUBLIC_COLLAB_URL')), {
      path: ['GRIMOIRE_PUBLIC_COLLAB_URL'], when: always,
      error: () => `is required when ${P}WEB_ROOT is set (the content security policy names it)`,
    })
    .refine(() => !(server && set('GRIMOIRE_WEB_ROOT') && !set('GRIMOIRE_S3_ENDPOINT')), {
      path: ['GRIMOIRE_S3_ENDPOINT'], when: always,
      error: () => `is required when ${P}WEB_ROOT is set (the content security policy names the file store)`,
    })
    // A remote image is no larger than an upload (contracts section 6).
    .refine((v) => {
      const r: unknown = v.GRIMOIRE_IMPORT_REMOTE_MAX_BYTES;
      const f: unknown = v.GRIMOIRE_FILES_MAX_BYTES;
      return !valid(r, 1, MAX_INT) || !valid(f, 1, MAX_INT) || r <= f;
    }, { path: ['GRIMOIRE_IMPORT_REMOTE_MAX_BYTES'], when: always, error: () => `must not be larger than ${P}FILES_MAX_BYTES` })
    // One zip is no larger than the import as a whole, and a workspace may stage at least one whole import: else a limit could never be reached, or an import could never be made.
    .refine((v) => {
      const z: unknown = v.GRIMOIRE_IMPORT_MAX_ZIP_BYTES;
      const t: unknown = v.GRIMOIRE_IMPORT_MAX_TOTAL_BYTES;
      return !valid(z, 1, MAX_INT) || !valid(t, 1, MAX_INT) || z <= t;
    }, { path: ['GRIMOIRE_IMPORT_MAX_ZIP_BYTES'], when: always, error: () => `must not be larger than ${P}IMPORT_MAX_TOTAL_BYTES` })
    .refine((v) => {
      const q: unknown = v.GRIMOIRE_IMPORT_STAGED_QUOTA_BYTES;
      const t: unknown = v.GRIMOIRE_IMPORT_MAX_TOTAL_BYTES;
      return !valid(q, 1, MAX_INT) || !valid(t, 1, MAX_INT) || q >= t;
    }, { path: ['GRIMOIRE_IMPORT_STAGED_QUOTA_BYTES'], when: always, error: () => `must not be smaller than ${P}IMPORT_MAX_TOTAL_BYTES` })
    // The running server never holds the database administrator's connection or the role passwords; only the db-setup step does.
    .refine(() => !(server && DB_SETUP_HELD.some(set)), {
      path: [DB_SETUP_HELD.find(set) ?? DB_SETUP_HELD[0]], when: always,
      error: () => 'must not be set for the server: only the db-setup step holds the administrator connection and the role passwords',
    })
    .refine(() => !(server && !local && set('GRIMOIRE_S3_ADMIN_ACCESS_KEY')), {
      path: ['GRIMOIRE_S3_ADMIN_ACCESS_KEY'], when: always,
      error: () => 'must not be set for the server outside local mode: only the files-setup step holds the admin key',
    })
    .refine((v) => { const t: unknown = v.GRIMOIRE_FILES_ALLOWED_TYPES; return !Array.isArray(t) || t.every((x) => typeof x !== 'string' || !executableType(x)); }, {
      path: ['GRIMOIRE_FILES_ALLOWED_TYPES'], when: always,
      error: () => `must not include a type a browser would run inline: script and XML types such as ${FORBIDDEN_TYPES.join(', ')}`,
    })
    .refine(() => !publicEndpointIsAnAppOrigin(raw), {
      path: [set('GRIMOIRE_S3_PUBLIC_ENDPOINT') ? 'GRIMOIRE_S3_PUBLIC_ENDPOINT' : 'GRIMOIRE_S3_ENDPOINT'], when: always,
      error: () => `must have an origin different from every origin in ${P}ALLOWED_ORIGINS (files are served from the store, not the app)`,
    });
};

/** Empty string counts as unset. */
const cleaned = (env: Readonly<Record<string, string | undefined>>): Raw =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));

const filesConfig = (v: z.output<ReturnType<typeof fieldSchema>>, purpose: Purpose): { readonly files?: FilesConfig } => {
  const endpoint = v.GRIMOIRE_S3_ENDPOINT;
  if (purpose === 'files-setup' || endpoint === undefined || v.GRIMOIRE_S3_BUCKET === undefined) {
    return {}; // files-setup holds the admin identity (`filesSetup`) and never the server's `files`; // the endpoint and the bucket come together: the rules above guarantee both or neither (the key pair is separate, both or neither)
  }
  const publicEndpoint = v.GRIMOIRE_S3_PUBLIC_ENDPOINT ?? endpoint;
  const { GRIMOIRE_S3_ACCESS_KEY: accessKey, GRIMOIRE_S3_SECRET_KEY: secretKey } = v;
  return { files: {
    endpoint, publicEndpoint, publicOrigin: publicOriginOf(publicEndpoint, v.GRIMOIRE_S3_BUCKET, v.GRIMOIRE_S3_ADDRESSING_STYLE ?? 'path'),
    bucket: v.GRIMOIRE_S3_BUCKET,
    ...(accessKey !== undefined && secretKey !== undefined ? { accessKey, secretKey } : {}),
    region: v.GRIMOIRE_S3_REGION ?? 'us-east-1', addressing: v.GRIMOIRE_S3_ADDRESSING_STYLE ?? 'path',
    createOnlyHeader: v.GRIMOIRE_S3_CREATE_ONLY_HEADER, corsMode: v.GRIMOIRE_S3_CORS_MODE,
    maxBytes: v.GRIMOIRE_FILES_MAX_BYTES, allowedTypes: v.GRIMOIRE_FILES_ALLOWED_TYPES, pendingMaxPerUser: v.GRIMOIRE_FILES_PENDING_MAX_PER_USER,
  } };
};

/** The files-setup step: the admin identity and the store, never the runtime key. */
const filesSetupConfig = (v: z.output<ReturnType<typeof fieldSchema>>, purpose: Purpose): { readonly filesSetup?: FilesSetupConfig } =>
  purpose === 'files-setup' && v.GRIMOIRE_S3_ENDPOINT !== undefined && v.GRIMOIRE_S3_BUCKET !== undefined
    && v.GRIMOIRE_S3_ADMIN_ACCESS_KEY !== undefined && v.GRIMOIRE_S3_ADMIN_SECRET_KEY !== undefined
    ? { filesSetup: {
      endpoint: v.GRIMOIRE_S3_ENDPOINT, publicEndpoint: v.GRIMOIRE_S3_PUBLIC_ENDPOINT ?? v.GRIMOIRE_S3_ENDPOINT, bucket: v.GRIMOIRE_S3_BUCKET, region: v.GRIMOIRE_S3_REGION ?? 'us-east-1',
      addressing: v.GRIMOIRE_S3_ADDRESSING_STYLE ?? 'path', corsMode: v.GRIMOIRE_S3_CORS_MODE,
      createOnlyHeader: v.GRIMOIRE_S3_CREATE_ONLY_HEADER,
      accessKey: v.GRIMOIRE_S3_ADMIN_ACCESS_KEY, secretKey: v.GRIMOIRE_S3_ADMIN_SECRET_KEY,
    } }
    : {};

const toConfig = (v: z.output<ReturnType<typeof fieldSchema>>, purpose: Purpose): Config => ({
  local: v.GRIMOIRE_LOCAL === '1',
  role: v.GRIMOIRE_ROLE,
  host: v.GRIMOIRE_HOST,
  port: v.GRIMOIRE_PORT,
  ...(v.GRIMOIRE_COLLAB_PORT !== undefined ? { collabPort: v.GRIMOIRE_COLLAB_PORT } : {}),
  logLevel: v.GRIMOIRE_LOG_LEVEL,
  env: v.GRIMOIRE_ENV,
  database: {
    ...(v.GRIMOIRE_DATABASE_URL !== undefined ? { url: v.GRIMOIRE_DATABASE_URL } : {}),
    ...(v.GRIMOIRE_DATABASE_MIGRATION_URL !== undefined ? { migrationUrl: v.GRIMOIRE_DATABASE_MIGRATION_URL } : {}),
    ...(v.GRIMOIRE_DATABASE_OPS_URL !== undefined ? { opsUrl: v.GRIMOIRE_DATABASE_OPS_URL } : {}),
  },
  ...(purpose === 'db-setup' && v.GRIMOIRE_DATABASE_ADMIN_URL !== undefined && v.GRIMOIRE_DB_APP_PASSWORD !== undefined && v.GRIMOIRE_DB_MIGRATOR_PASSWORD !== undefined && v.GRIMOIRE_DB_OPS_PASSWORD !== undefined
    ? { dbSetup: { adminUrl: v.GRIMOIRE_DATABASE_ADMIN_URL, appPassword: v.GRIMOIRE_DB_APP_PASSWORD, migratorPassword: v.GRIMOIRE_DB_MIGRATOR_PASSWORD, opsPassword: v.GRIMOIRE_DB_OPS_PASSWORD } }
    : {}),
  ...(v.GRIMOIRE_DEV_TOKEN_SECRET !== undefined ? { devTokenSecret: v.GRIMOIRE_DEV_TOKEN_SECRET } : {}),
  localAllowNonLoopback: v.GRIMOIRE_LOCAL_ALLOW_NON_LOOPBACK === '1',
  ...(v.GRIMOIRE_DESCOPE_PROJECT_ID !== undefined ? { descopeProjectId: v.GRIMOIRE_DESCOPE_PROJECT_ID } : {}),
  ...(v.GRIMOIRE_DESCOPE_BASE_URL !== undefined ? { descopeBaseUrl: v.GRIMOIRE_DESCOPE_BASE_URL } : {}),
  ...(v.GRIMOIRE_DESCOPE_MANAGEMENT_KEY !== undefined ? { descopeManagementKey: v.GRIMOIRE_DESCOPE_MANAGEMENT_KEY } : {}),
  firstAdminEmails: v.GRIMOIRE_FIRST_ADMIN_EMAILS,
  ...filesConfig(v, purpose),
  ...filesSetupConfig(v, purpose),
  descopeMaxTokenLifetimeSeconds: v.GRIMOIRE_DESCOPE_MAX_TOKEN_LIFETIME_SECONDS,
  allowedEmailDomains: v.GRIMOIRE_ALLOWED_EMAIL_DOMAINS,
  refusedEmailDomains: v.GRIMOIRE_REFUSED_EMAIL_DOMAINS,
  allowedOrigins: v.GRIMOIRE_ALLOWED_ORIGINS ?? [],
  trustedProxies: v.GRIMOIRE_TRUSTED_PROXY,
  shutdownSaveDeadlineMs: v.GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS,
  requireHandshake: v.GRIMOIRE_REQUIRE_HANDSHAKE === '1',
  minClientVersion: v.GRIMOIRE_MIN_CLIENT_VERSION,
  ...(v.GRIMOIRE_PUBLIC_COLLAB_URL !== undefined ? { publicCollabUrl: v.GRIMOIRE_PUBLIC_COLLAB_URL } : {}),
  ...(v.GRIMOIRE_PUBLIC_API_URL !== undefined ? { publicApiUrl: v.GRIMOIRE_PUBLIC_API_URL } : {}),
  ...(v.GRIMOIRE_WEB_ROOT !== undefined ? { webRoot: v.GRIMOIRE_WEB_ROOT } : {}),
  http: {
    userLimitPerMinute: v.GRIMOIRE_HTTP_USER_LIMIT_PER_MINUTE,
    addressLimitPerMinute: v.GRIMOIRE_HTTP_ADDRESS_LIMIT_PER_MINUTE,
    addressCeilingPerMinute: v.GRIMOIRE_HTTP_ADDRESS_CEILING_PER_MINUTE,
  },
  tenantLimits: {
    maxUsers: v.GRIMOIRE_TENANT_MAX_USERS,
    maxStorageBytes: v.GRIMOIRE_TENANT_MAX_STORAGE_BYTES,
    maxPages: v.GRIMOIRE_TENANT_MAX_PAGES,
  },
  collab: {
    maxPayloadBytes: v.GRIMOIRE_COLLAB_MAX_PAYLOAD_BYTES, maxStateBytes: v.GRIMOIRE_COLLAB_MAX_STATE_BYTES,
    seedMaxMarkdownBytes: v.GRIMOIRE_SEED_MAX_MARKDOWN_BYTES, seedTimeoutMs: v.GRIMOIRE_SEED_TIMEOUT_MS, reseedTimeoutMs: v.GRIMOIRE_RESEED_TIMEOUT_MS, saveTimeoutMs: v.GRIMOIRE_SAVE_TIMEOUT_MS, convertPoolSize: v.GRIMOIRE_CONVERT_POOL_SIZE,
    stateWarnPercent: v.GRIMOIRE_COLLAB_STATE_WARN_PERCENT, messagesPerWindow: v.GRIMOIRE_COLLAB_MESSAGES_PER_WINDOW,
    rateWindowSeconds: v.GRIMOIRE_COLLAB_RATE_WINDOW_SECONDS, maxConnectionsPerPage: v.GRIMOIRE_COLLAB_MAX_CONNECTIONS_PER_PAGE,
    maxConnections: v.GRIMOIRE_COLLAB_MAX_CONNECTIONS, maxOpenDocuments: v.GRIMOIRE_COLLAB_MAX_OPEN_DOCUMENTS,
    memoryLimitBytes: v.GRIMOIRE_COLLAB_MEMORY_LIMIT_BYTES, memoryGuardPercent: v.GRIMOIRE_COLLAB_MEMORY_GUARD_PERCENT,
    idleUnloadSeconds: v.GRIMOIRE_COLLAB_IDLE_UNLOAD_SECONDS, connectAttemptsPerWindow: v.GRIMOIRE_COLLAB_CONNECT_ATTEMPTS_PER_WINDOW,
    connectWindowSeconds: v.GRIMOIRE_COLLAB_CONNECT_WINDOW_SECONDS, banSeconds: v.GRIMOIRE_COLLAB_BAN_SECONDS,
    maxUnauthSocketsPerAddress: v.GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS_PER_ADDRESS,
    maxUnauthSockets: v.GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS, maxUnauthQueuedBytes: v.GRIMOIRE_COLLAB_MAX_UNAUTH_QUEUED_BYTES, debounceMs: v.GRIMOIRE_COLLAB_DEBOUNCE_MS,
    maxDebounceMs: v.GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS, storeRetryBaseMs: v.GRIMOIRE_COLLAB_STORE_RETRY_BASE_MS,
    storeRetryMaxMs: v.GRIMOIRE_COLLAB_STORE_RETRY_MAX_MS, storeTimeoutMs: v.GRIMOIRE_COLLAB_STORE_TIMEOUT_MS,
    preauthTimeoutSeconds: v.GRIMOIRE_COLLAB_PREAUTH_TIMEOUT_SECONDS,
    maxSocketsPerUser: v.GRIMOIRE_COLLAB_MAX_SOCKETS_PER_USER, maxDocumentsPerUser: v.GRIMOIRE_COLLAB_MAX_DOCUMENTS_PER_USER,
    bytesPerSecondPerUser: v.GRIMOIRE_COLLAB_BYTES_PER_SECOND_PER_USER,
    recheckSeconds: v.GRIMOIRE_COLLAB_RECHECK_SECONDS,
  },
  import: {
    maxZipBytes: v.GRIMOIRE_IMPORT_MAX_ZIP_BYTES, maxZips: v.GRIMOIRE_IMPORT_MAX_ZIPS, maxTotalBytes: v.GRIMOIRE_IMPORT_MAX_TOTAL_BYTES, stagedQuotaBytes: v.GRIMOIRE_IMPORT_STAGED_QUOTA_BYTES,
    maxEntries: v.GRIMOIRE_IMPORT_MAX_ENTRIES, maxUncompressedBytes: v.GRIMOIRE_IMPORT_MAX_UNCOMPRESSED_BYTES,
    maxRatio: v.GRIMOIRE_IMPORT_MAX_RATIO, maxEntryBytes: v.GRIMOIRE_IMPORT_MAX_ENTRY_BYTES, maxTableBytes: v.GRIMOIRE_IMPORT_MAX_TABLE_BYTES,
    allowNestedZips: v.GRIMOIRE_IMPORT_ALLOW_NESTED_ZIPS === '1', fetchRemoteImages: v.GRIMOIRE_IMPORT_FETCH_REMOTE_IMAGES === '1',
    remote: {
      maxImages: v.GRIMOIRE_IMPORT_REMOTE_MAX_IMAGES, maxBytes: v.GRIMOIRE_IMPORT_REMOTE_MAX_BYTES ?? Math.min(20_971_520, v.GRIMOIRE_FILES_MAX_BYTES),
      timeoutSeconds: v.GRIMOIRE_IMPORT_REMOTE_TIMEOUT_SECONDS, totalSeconds: v.GRIMOIRE_IMPORT_REMOTE_TOTAL_SECONDS,
    },
    concurrency: v.GRIMOIRE_IMPORT_CONCURRENCY,
  },
  jobs: {
    importExpireSeconds: v.GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS, stopGraceMs: v.GRIMOIRE_JOBS_STOP_GRACE_MS,
    purgeCron: v.GRIMOIRE_JOBS_PURGE_CRON, uploadCleanupCron: v.GRIMOIRE_JOBS_UPLOAD_CLEANUP_CRON, revisionCron: v.GRIMOIRE_JOBS_REVISION_CRON, sweepCron: v.GRIMOIRE_JOBS_SWEEP_CRON,
  },
  search: { statementTimeoutMs: v.GRIMOIRE_SEARCH_STATEMENT_TIMEOUT_MS },
  semantic: {
    enabled: v.GRIMOIRE_SEMANTIC_SEARCH === 'on', model: v.GRIMOIRE_SEMANTIC_MODEL, modelDir: v.GRIMOIRE_SEMANTIC_MODEL_DIR, threads: v.GRIMOIRE_SEMANTIC_THREADS,
    debounceSeconds: v.GRIMOIRE_SEMANTIC_DEBOUNCE_SECONDS, sweepSeconds: v.GRIMOIRE_SEMANTIC_SWEEP_SECONDS, maxChunksPerMinute: v.GRIMOIRE_SEMANTIC_MAX_CHUNKS_PER_MINUTE,
    queryTimeoutMs: v.GRIMOIRE_SEMANTIC_QUERY_TIMEOUT_MS, minSimilarity: v.GRIMOIRE_SEMANTIC_MIN_SIMILARITY, candidates: v.GRIMOIRE_SEMANTIC_CANDIDATES,
  },
});

/** Validates the environment (empty string counts as unset) and maps it to Config, or returns every issue. */
export function parseEnv(env: Readonly<Record<string, string | undefined>>, purpose: Purpose):
  { readonly config: Config } | { readonly issues: readonly z.core.$ZodIssue[] } {
  const raw = cleaned(env);
  const result = envSchema(purpose, raw).safeParse(raw);
  return result.success ? { config: toConfig(result.data, purpose) } : { issues: result.error.issues };
}
