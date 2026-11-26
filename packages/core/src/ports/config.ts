import type { LogLevel } from './logger.js';

/** Collaboration limits; field = camelCase of the GRIMOIRE_COLLAB_* suffix (contracts section 3). */
export interface CollabConfig {
  readonly maxPayloadBytes: number;
  readonly maxStateBytes: number;
  /** Largest Markdown, in UTF-8 bytes, that is turned into a page. */
  readonly seedMaxMarkdownBytes: number;
  /** Time one Markdown-to-page conversion may take before its worker is stopped. */
  readonly seedTimeoutMs: number;
  /** Time one rebuild of a page from the Markdown its own serialiser stored may take. */
  readonly reseedTimeoutMs: number;
  /** Time one conversion of a page's state to Markdown (a save) may take before its worker is stopped. */
  readonly saveTimeoutMs: number;
  /** Worker threads converting Markdown and page state. */
  readonly convertPoolSize: number;
  readonly stateWarnPercent: number;
  readonly messagesPerWindow: number;
  readonly rateWindowSeconds: number;
  readonly maxConnectionsPerPage: number;
  readonly maxConnections: number;
  readonly maxOpenDocuments: number;
  readonly memoryLimitBytes: number;
  readonly memoryGuardPercent: number;
  readonly idleUnloadSeconds: number;
  readonly connectAttemptsPerWindow: number;
  readonly connectWindowSeconds: number;
  readonly banSeconds: number;
  readonly maxUnauthSocketsPerAddress: number;
  readonly maxUnauthSockets: number;
  /** Close and release an unauthenticated socket after this many seconds. */
  readonly preauthTimeoutSeconds: number;
  /** Per-user caps count authenticated sockets and document sessions, not just distinct sockets/documents. */
  readonly maxSocketsPerUser: number;
  readonly maxDocumentsPerUser: number;
  /** Update bytes accepted per second across every page edited by one user. */
  readonly bytesPerSecondPerUser: number;
  readonly maxUnauthQueuedBytes: number;
  readonly debounceMs: number;
  readonly maxDebounceMs: number;
  readonly storeRetryBaseMs: number;
  readonly storeRetryMaxMs: number;
  /** One page-store query (load or store) gives up after this long; shorter than the shutdown save deadline. */
  readonly storeTimeoutMs: number;
  /** Re-check signed collaboration access this often, after the current grant expires. */
  readonly recheckSeconds: number;
}

/** Limits of the HTTP API, counted per minute (contracts section 9). */
export interface HttpConfig {
  /** Requests one signed-in user may make per minute. */
  readonly userLimitPerMinute: number;
  /** Requests per minute from one address that carry no credentials or a token that fails verification. */
  readonly addressLimitPerMinute: number;
  /** Flood guard: every request from one address, per minute. */
  readonly addressCeilingPerMinute: number;
}

/** The caps of one tenant (docs/tenancy.md section 3.8); field = camelCase of the GRIMOIRE_TENANT_* suffix. */
export interface TenantLimitsConfig {
  /** People of one tenant; a new person past it is refused at sign-in. */
  readonly maxUsers: number;
  /** Bytes of the files of one tenant; an upload past it is refused. */
  readonly maxStorageBytes: number;
  /** Open pages (not in the trash) of one tenant; a create or a restore past it is refused. */
  readonly maxPages: number;
}

/** The file store (S3 protocol). Present when the store variables are set; the admin key is never part of it. */
export interface FilesConfig {
  /** Internal URL the server uses. */
  readonly endpoint: string;
  /** URL the browser uses, put into signed URLs; the internal endpoint when unset. */
  readonly publicEndpoint: string;
  /** Origin of `publicEndpoint`: what the Content-Security-Policy lists as the store origin. */
  readonly publicOrigin: string;
  readonly bucket: string;
  /** The runtime key pair, both or neither. Absent: the AWS default credential chain (a task role on AWS); present: a store with its own keys (local development). */
  readonly accessKey?: string;
  readonly secretKey?: string;
  readonly region: string;
  readonly addressing: 'path' | 'virtual';
  /** Header that makes a signed PUT create-only. */
  readonly createOnlyHeader: 'if-none-match' | 'x-goog-if-generation-match';
  /** `api`: the setup step configures the store's CORS; `external`: the operator does. */
  readonly corsMode: 'api' | 'external';
  readonly maxBytes: number;
  readonly allowedTypes: readonly string[];
  /** Pending uploads one user may hold; above it the API answers 429 rate_limited. */
  readonly pendingMaxPerUser: number;
}

/** What `grimoire files-setup` needs: the store and the admin identity (never part of the server's `files`). */
export interface FilesSetupConfig {
  readonly endpoint: string;
  /** The URL browsers use (a path prefix included); the internal endpoint when none is set, as in `FilesConfig`. */
  readonly publicEndpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly addressing: 'path' | 'virtual';
  readonly corsMode: 'api' | 'external';
  /** The header a signed upload carries to be create-only: the CORS rule has to allow it. */
  readonly createOnlyHeader: 'if-none-match' | 'x-goog-if-generation-match';
  readonly accessKey: string;
  readonly secretKey: string;
}

/** What `grimoire db-setup` needs: the administrator's connection to the database and the three passwords to give the product's roles (never part of the server's settings). */
export interface DatabaseSetupConfig {
  readonly adminUrl: string;
  readonly appPassword: string;
  readonly migratorPassword: string;
  readonly opsPassword: string;
}

/** The import's limits and the remote-image fetcher's (contracts section 6). The size of a Markdown file is the seed cap of `collab`, not a setting of its own. */
export interface ImportConfig {
  /** What one import takes: the size of each zip, how many zips (an export in parts is several), and their size together. */
  readonly maxZipBytes: number; readonly maxZips: number; readonly maxTotalBytes: number;
  /** What a workspace may hold in imports that are not over (`created`, `uploaded`, `running`: their zips are in the store), a new import's included. */
  readonly stagedQuotaBytes: number;
  readonly maxEntries: number; readonly maxUncompressedBytes: number;
  /** The ratio of uncompressed to compressed bytes, for the archive and for each entry. */
  readonly maxRatio: number; readonly maxEntryBytes: number; readonly maxTableBytes: number;
  readonly allowNestedZips: boolean; readonly fetchRemoteImages: boolean;
  readonly remote: { readonly maxImages: number; readonly maxBytes: number; readonly timeoutSeconds: number; readonly totalSeconds: number };
  /** Workers of the `import` queue. */
  readonly concurrency: number;
  /** From which size a zip goes up in parts, and how big a part is. No setting fills it: the server's own sizes apply (4 GiB, 64 MiB) unless a test or a later setting gives others. */
  readonly uploadSizing?: { readonly singleMaxBytes: number; readonly partBytes: number };
}

/** The job queue's expiries and schedules (cron is UTC, five fields). */
export interface JobsConfig {
  readonly importExpireSeconds: number; readonly stopGraceMs: number;
  readonly purgeCron: string; readonly uploadCleanupCron: string; readonly revisionCron: string; readonly sweepCron: string;
}

export interface SearchConfig { readonly statementTimeoutMs: number }

/** The semantic search (contracts section 15.6). */
export interface SemanticConfig {
  /** `GRIMOIRE_SEMANTIC_SEARCH`: off means no embedder is started and no page is embedded. */
  readonly enabled: boolean;
  readonly model: 'multilingual-e5-base' | 'multilingual-e5-small';
  /** The folder the model files are read from, and the only place the adapter reads them (no network). */
  readonly modelDir: string;
  /** Threads of the one embedding worker. */
  readonly threads: number;
  /** A page is embedded when it has been left alone this long. */
  readonly debounceSeconds: number;
  readonly sweepSeconds: number;
  readonly maxChunksPerMinute: number;
  readonly queryTimeoutMs: number;
  /** Chunks under this cosine similarity are not results: 0 keeps every one and leaves the order to the rank fusion. */
  readonly minSimilarity: number;
  /** How many pages the full-text list and the semantic list each hand to the fusion. */
  readonly candidates: number;
}

export interface Config { readonly local: boolean; readonly role: 'all'|'api'|'collab';
  readonly host: string; readonly port: number; readonly collabPort?: number; readonly logLevel: LogLevel;
  /** The environment (the stage) the process runs in, written on every log line as `env`; `local` for a local run. */
  readonly env: string;
  /** `opsUrl`: the operator role's connection (docs/tenancy.md section 3.2), absent unless configured. */
  readonly database: { readonly url?: string; readonly migrationUrl?: string; readonly opsUrl?: string };
  /** Present only for the `db-setup` purpose. */
  readonly dbSetup?: DatabaseSetupConfig;
  readonly descopeProjectId?: string; readonly allowedOrigins: readonly string[];
  readonly descopeBaseUrl?: string;
  /** Maximum issued-token lifetime accepted by the Descope verifier, in seconds (default 24 hours). */
  readonly descopeMaxTokenLifetimeSeconds: number;
  /** Local or test profile lookup only; production uses trusted signed claims. */
  readonly descopeManagementKey?: string;
  readonly firstAdminEmails: readonly string[];
  /** Lowercase host names; empty is permitted only in local mode, never any domain. */
  readonly allowedEmailDomains: readonly string[];
  /** Lowercase host names refused on top of the public mailbox providers (GRIMOIRE_REFUSED_EMAIL_DOMAINS). */
  readonly refusedEmailDomains: readonly string[];
  readonly trustedProxies: readonly string[]; readonly shutdownSaveDeadlineMs: number;
  /** Local mode only: the secret every development token carries (GRIMOIRE_DEV_TOKEN_SECRET). */
  readonly devTokenSecret?: string;
  /** Local mode may bind a non-loopback address only when this is set (GRIMOIRE_LOCAL_ALLOW_NON_LOOPBACK). */
  readonly localAllowNonLoopback: boolean;
  readonly collab: CollabConfig;
  readonly import: ImportConfig;
  readonly jobs: JobsConfig;
  readonly search: SearchConfig;
  readonly semantic: SemanticConfig;
  readonly files?: FilesConfig;
  /** Only for the files-setup purpose. */
  readonly filesSetup?: FilesSetupConfig;
  readonly http: HttpConfig;
  readonly tenantLimits: TenantLimitsConfig;
  /** The address browsers use for the API (GRIMOIRE_PUBLIC_API_URL); absent when unset. */
  readonly publicApiUrl?: string;
  /** A folder with the built web client (GRIMOIRE_WEB_ROOT): when set the server serves it, with its own response headers. Absent: API and live editing only. */
  readonly webRoot?: string;
  /** The address browsers use for live editing (GRIMOIRE_PUBLIC_COLLAB_URL); absent when unset. */
  readonly publicCollabUrl?: string;
  /** When true, a bare session token on the WebSocket is refused as too old a client. */
  readonly requireHandshake: boolean;
  /** Oldest client version accepted, as `major.minor.patch`. */
  readonly minClientVersion: string }
