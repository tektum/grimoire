import type { CollabConfig, Config, HttpConfig, ImportConfig, JobsConfig, SearchConfig, SemanticConfig, TenantLimitsConfig } from '../ports/config.js';

export const defaultCollabConfig: CollabConfig = {
  maxPayloadBytes: 1048576,
  maxStateBytes: 1_000_000,
  seedMaxMarkdownBytes: 131_072,
  seedTimeoutMs: 10_000,
  reseedTimeoutMs: 30000,
  saveTimeoutMs: 10000,
  convertPoolSize: 2,
  stateWarnPercent: 80,
  messagesPerWindow: 300,
  rateWindowSeconds: 10,
  maxConnectionsPerPage: 100,
  maxConnections: 500,
  maxOpenDocuments: 200,
  memoryLimitBytes: 1073741824,
  memoryGuardPercent: 80,
  idleUnloadSeconds: 60,
  connectAttemptsPerWindow: 50,
  connectWindowSeconds: 60,
  banSeconds: 300,
  maxUnauthSocketsPerAddress: 10, maxUnauthSockets: 500, preauthTimeoutSeconds: 5, maxUnauthQueuedBytes: 67_108_864,
  maxSocketsPerUser: 20, maxDocumentsPerUser: 50, bytesPerSecondPerUser: 2 * 1024 * 1024,
  debounceMs: 3000,
  maxDebounceMs: 10000,
  storeRetryBaseMs: 1000,
  storeRetryMaxMs: 30000,
  storeTimeoutMs: 2000,
  recheckSeconds: 60,
};

export const defaultHttpConfig: HttpConfig = { userLimitPerMinute: 1000, addressLimitPerMinute: 60, addressCeilingPerMinute: 6000 };

export const defaultImportConfig: ImportConfig = {
  maxZipBytes: 524_288_000, maxEntries: 20_000, maxUncompressedBytes: 2_147_483_648, maxRatio: 100, maxEntryBytes: 104_857_600, maxTableBytes: 262_144, allowNestedZips: false,
  fetchRemoteImages: true, remote: { maxImages: 200, maxBytes: 20_971_520, timeoutSeconds: 10, totalSeconds: 300 }, concurrency: 2,
};
export const defaultJobsConfig: JobsConfig = { importExpireSeconds: 900, stopGraceMs: 1500, purgeCron: '17 3 * * *', uploadCleanupCron: '*/15 * * * *', revisionCron: '47 3 * * *', sweepCron: '*/5 * * * *' };
export const defaultSearchConfig: SearchConfig = { statementTimeoutMs: 3000 };
export const defaultSemanticConfig: SemanticConfig = {
  enabled: true, model: 'multilingual-e5-base', modelDir: '/app/models', threads: 2, debounceSeconds: 30, sweepSeconds: 15, maxChunksPerMinute: 600, queryTimeoutMs: 1500, minSimilarity: 0, candidates: 100,
};
export const defaultTenantLimits: TenantLimitsConfig = { maxUsers: 1000, maxStorageBytes: 10 * 1024 ** 3, maxPages: 50_000 };

/** A valid local-mode Config for tests, with shallow overrides (collab is merged). */
export function makeFakeConfig(
  overrides: Partial<Omit<Config, 'collab' | 'http' | 'import' | 'jobs' | 'search' | 'semantic'>> & {
    readonly collab?: Partial<CollabConfig>; readonly http?: Partial<HttpConfig>; readonly import?: Partial<ImportConfig>; readonly jobs?: Partial<JobsConfig>; readonly search?: Partial<SearchConfig>; readonly semantic?: Partial<SemanticConfig>;
  } = {},
): Config {
  const { collab, http, import: importing, jobs, search, semantic, ...rest } = overrides;
  return {
    local: true,
    role: 'all',
    host: '127.0.0.1',
    port: 8080,
    logLevel: 'info',
    env: 'local',
    database: {},
    firstAdminEmails: [],
    allowedEmailDomains: [],
    refusedEmailDomains: [],
    allowedOrigins: ['http://127.0.0.1:8080'],
    trustedProxies: [],
    localAllowNonLoopback: false,
    shutdownSaveDeadlineMs: 45000,
    descopeMaxTokenLifetimeSeconds: 86400,
    requireHandshake: false,
    minClientVersion: '0.0.0',
    tenantLimits: defaultTenantLimits,
    ...rest,
    collab: { ...defaultCollabConfig, ...collab },
    http: { ...defaultHttpConfig, ...http },
    import: { ...defaultImportConfig, ...importing },
    jobs: { ...defaultJobsConfig, ...jobs },
    search: { ...defaultSearchConfig, ...search },
    semantic: { ...defaultSemanticConfig, ...semantic },
  };
}
