import type { CollabConfig, Config } from '../ports/config.js';

export const defaultCollabConfig: CollabConfig = {
  maxPayloadBytes: 1048576,
  maxStateBytes: 1536000,
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

/** A valid local-mode Config for tests, with shallow overrides (collab is merged). */
export function makeFakeConfig(
  overrides: Partial<Omit<Config, 'collab'>> & { readonly collab?: Partial<CollabConfig> } = {},
): Config {
  const { collab, ...rest } = overrides;
  return {
    local: true,
    role: 'all',
    host: '127.0.0.1',
    port: 8080,
    logLevel: 'info',
    database: {},
    firstAdminEmails: [],
    allowedEmailDomains: [],
    allowedOrigins: ['http://127.0.0.1:8080'],
    trustedProxies: [],
    localAllowNonLoopback: false,
    shutdownSaveDeadlineMs: 45000,
    descopeMaxTokenLifetimeSeconds: 86400,
    ...rest,
    collab: { ...defaultCollabConfig, ...collab },
  };
}
