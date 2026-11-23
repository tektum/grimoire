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

/** The file store (S3 protocol). Present when the store variables are set; the admin key is never part of it. */
export interface FilesConfig {
  /** Internal URL the server uses. */
  readonly endpoint: string;
  /** URL the browser uses, put into signed URLs; the internal endpoint when unset. */
  readonly publicEndpoint: string;
  /** Origin of `publicEndpoint`: what the Content-Security-Policy lists as the store origin. */
  readonly publicOrigin: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
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
  readonly bucket: string;
  readonly region: string;
  readonly addressing: 'path' | 'virtual';
  readonly corsMode: 'api' | 'external';
  /** The header a signed upload carries to be create-only: the CORS rule has to allow it. */
  readonly createOnlyHeader: 'if-none-match' | 'x-goog-if-generation-match';
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface Config { readonly local: boolean; readonly role: 'all'|'api'|'collab';
  readonly host: string; readonly port: number; readonly collabPort?: number; readonly logLevel: LogLevel;
  readonly database: { readonly url?: string; readonly migrationUrl?: string };
  readonly descopeProjectId?: string; readonly allowedOrigins: readonly string[];
  readonly descopeBaseUrl?: string;
  /** Maximum issued-token lifetime accepted by the Descope verifier, in seconds (default 24 hours). */
  readonly descopeMaxTokenLifetimeSeconds: number;
  /** Local or test profile lookup only; production uses trusted signed claims. */
  readonly descopeManagementKey?: string;
  readonly firstAdminEmails: readonly string[];
  /** Lowercase host names; empty is permitted only in local mode, never any domain. */
  readonly allowedEmailDomains: readonly string[];
  readonly trustedProxies: readonly string[]; readonly shutdownSaveDeadlineMs: number;
  /** Local mode only: the secret every development token carries (GRIMOIRE_DEV_TOKEN_SECRET). */
  readonly devTokenSecret?: string;
  /** Local mode may bind a non-loopback address only when this is set (GRIMOIRE_LOCAL_ALLOW_NON_LOOPBACK). */
  readonly localAllowNonLoopback: boolean;
  readonly collab: CollabConfig;
  readonly files?: FilesConfig;
  /** Only for the files-setup purpose. */
  readonly filesSetup?: FilesSetupConfig;
  readonly http: HttpConfig;
  /** The address browsers use for live editing (GRIMOIRE_PUBLIC_COLLAB_URL); absent when unset. */
  readonly publicCollabUrl?: string;
  /** When true, a bare session token on the WebSocket is refused as too old a client. */
  readonly requireHandshake: boolean;
  /** Oldest client version accepted, as `major.minor.patch`. */
  readonly minClientVersion: string }
