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

const PORT_MAX = 65535;
const HOST_RULE = 'must be an IPv4 or IPv6 address literal (no hostname, no port)';
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

type Purpose = 'server' | 'migrate' | 'files-setup';
type Raw = Readonly<Record<string, string>>;
type S3Required = 'ENDPOINT' | 'BUCKET';
const S3_ANY = ['ENDPOINT', 'PUBLIC_ENDPOINT', 'BUCKET', 'ACCESS_KEY', 'SECRET_KEY', 'REGION', 'ADDRESSING_STYLE'] as const;
const SERVER_ONLY = 'is required to run the server';
const SETUP_ONLY = 'is required to run files-setup';

const MIME_RULE = 'must be a comma list of lowercase type/subtype names';
const FORBIDDEN_TYPES = ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/javascript', 'application/javascript'];
// The 15 types of R9.14: images, documents, archives and video that a browser never runs inline.
const DEFAULT_TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf', 'text/plain', 'text/csv', 'text/markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip', 'video/mp4', 'video/webm',
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
  GRIMOIRE_DATABASE_URL: field(dbUrl, purpose === 'server' ? SERVER_ONLY : undefined),
  GRIMOIRE_DATABASE_MIGRATION_URL: field(dbUrl, purpose === 'migrate' ? 'is required to run migrations' : undefined),
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
  GRIMOIRE_FILES_MAX_BYTES: field(int(1, MAX_INT)).default(26_214_400),
  GRIMOIRE_FILES_ALLOWED_TYPES: field(list(mime, MIME_RULE), undefined, true).default(DEFAULT_TYPES),
  GRIMOIRE_FILES_PENDING_MAX_PER_USER: field(int(1, MAX_INT)).default(10),
  GRIMOIRE_REQUIRE_HANDSHAKE: field(z.enum(['0', '1'], msg('must be 0 or 1'))).default('0'),
  GRIMOIRE_MIN_CLIENT_VERSION: field(z.string(msg(VERSION_RULE)).refine((v) => parseVersion(v) !== null, msg(VERSION_RULE))).default('0.0.0'),
  GRIMOIRE_HTTP_USER_LIMIT_PER_MINUTE: field(int(1, MAX_INT)).default(1000),
  GRIMOIRE_HTTP_ADDRESS_LIMIT_PER_MINUTE: field(int(1, MAX_INT)).default(60),
  GRIMOIRE_HTTP_ADDRESS_CEILING_PER_MINUTE: field(int(1, MAX_INT)).default(6000),
  GRIMOIRE_PUBLIC_API_URL: field(httpUrl),
  GRIMOIRE_PUBLIC_COLLAB_URL: field(z.url({ protocol: /^(?:https?|wss?)$/, ...msg('must be an http(s):// or ws(s):// URL') })),
  GRIMOIRE_FIRST_ADMIN_EMAILS: field(list(email.transform((v) => v.toLowerCase()), emailRule), undefined, true).transform((v) => [...new Set(v ?? [])]).default([]),
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
/** Whether the public store endpoint shares an origin with an allowed app origin (a stored file would then run as the app). */
const publicEndpointIsAnAppOrigin = (raw: Raw): boolean => {
  const endpoint = raw['GRIMOIRE_S3_PUBLIC_ENDPOINT'] ?? raw['GRIMOIRE_S3_ENDPOINT']; // the one Config.files will use
  if (endpoint === undefined || !URL.canParse(endpoint)) return false; // the URL rule reports a bad value
  const storeOrigin = new URL(endpoint).origin.toLowerCase();
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
    endpoint, publicEndpoint, publicOrigin: new URL(publicEndpoint).origin,
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
  database: {
    ...(v.GRIMOIRE_DATABASE_URL !== undefined ? { url: v.GRIMOIRE_DATABASE_URL } : {}),
    ...(v.GRIMOIRE_DATABASE_MIGRATION_URL !== undefined ? { migrationUrl: v.GRIMOIRE_DATABASE_MIGRATION_URL } : {}),
  },
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
  allowedOrigins: v.GRIMOIRE_ALLOWED_ORIGINS ?? [],
  trustedProxies: v.GRIMOIRE_TRUSTED_PROXY,
  shutdownSaveDeadlineMs: v.GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS,
  requireHandshake: v.GRIMOIRE_REQUIRE_HANDSHAKE === '1',
  minClientVersion: v.GRIMOIRE_MIN_CLIENT_VERSION,
  ...(v.GRIMOIRE_PUBLIC_COLLAB_URL !== undefined ? { publicCollabUrl: v.GRIMOIRE_PUBLIC_COLLAB_URL } : {}),
  http: {
    userLimitPerMinute: v.GRIMOIRE_HTTP_USER_LIMIT_PER_MINUTE,
    addressLimitPerMinute: v.GRIMOIRE_HTTP_ADDRESS_LIMIT_PER_MINUTE,
    addressCeilingPerMinute: v.GRIMOIRE_HTTP_ADDRESS_CEILING_PER_MINUTE,
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
});

/** Validates the environment (empty string counts as unset) and maps it to Config, or returns every issue. */
export function parseEnv(env: Readonly<Record<string, string | undefined>>, purpose: Purpose):
  { readonly config: Config } | { readonly issues: readonly z.core.$ZodIssue[] } {
  const raw = cleaned(env);
  const result = envSchema(purpose, raw).safeParse(raw);
  return result.success ? { config: toConfig(result.data, purpose) } : { issues: result.error.issues };
}
