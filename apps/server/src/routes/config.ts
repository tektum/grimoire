import { z } from '@hono/zod-openapi';
import { errorResponse } from '../http/error.js';
import { createRouter, defineRoute } from '../http/factory.js';

export const ClientConfigSchema = z
  .object({
    collabUrl: z.string().describe('Address browsers use for live editing'),
    minClientVersion: z.string().describe('Oldest client version the server accepts'),
    local: z.boolean().describe('True only in local (development) mode'),
    providerProjectId: z.string().nullable().describe('Sign-in provider project id; null when none is configured'),
    fileStoreOrigin: z.string().nullable().describe('Public origin of the file store; null when no store is configured'),
  })
  .openapi('ClientConfig');

export const getConfig = defineRoute({
  method: 'get',
  path: '/v1/config',
  operationId: 'getConfig',
  summary: 'What a client needs before it signs in',
  tags: ['config'],
  policy: { kind: 'public' },
  responses: { 200: { description: 'The client configuration', content: { 'application/json': { schema: ClientConfigSchema } } } },
});

/** A bind address is not always one a browser can dial: the unspecified addresses become loopback, and an IPv6 literal is bracketed. */
function browserHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return '127.0.0.1';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

const router = createRouter();

router.openapi(getConfig, (c) => {
  const { config, log } = c.get('deps');
  // Local mode may derive the address from where the server listens; any other mode must be told.
  const collabUrl = config.publicCollabUrl ?? (config.local ? `ws://${browserHost(config.host)}:${String(config.collabPort ?? config.port)}/collab` : undefined);
  if (collabUrl === undefined) {
    log.warn('config.collab_url_missing', {});
    return errorResponse('unavailable') as never;
  }
  return c.json(
    {
      collabUrl,
      minClientVersion: config.minClientVersion,
      local: config.local,
      providerProjectId: config.descopeProjectId ?? null,
      fileStoreOrigin: config.files?.publicOrigin ?? null,
    },
    200,
  );
});

export default router;
