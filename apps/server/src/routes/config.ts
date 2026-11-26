import { z } from '@hono/zod-openapi';
import { errorResponse } from '../http/error.js';
import { createRouter, defineRoute } from '../http/factory.js';

export const ClientConfigSchema = z
  .object({
    collabUrl: z.string().describe('Address browsers use for live editing'),
    minClientVersion: z.string().describe('Oldest client version the server accepts'),
    local: z.boolean().describe('True only in local (development) mode'),
    providerProjectId: z.string().nullable().describe('Sign-in provider project id; null when none is configured'),
    providerBaseUrl: z.string().nullable().describe('The endpoint of the sign-in provider that browsers use, the same one the server calls (a regional project has its own); null when no project is configured'),
    fileStoreOrigin: z.string().nullable().describe('Public origin of the file store; null when no store is configured'),
    maxAttachmentBytes: z.number().int().nullable().describe('The largest upload the server accepts, in bytes; null when no store is configured'),
    pendingUploadsMax: z.number().int().nullable().describe('How many unfinished uploads one person may have at once; null when no store is configured'),
    maxImportZips: z.number().int().describe('How many zips one import takes (an export in parts is several)'),
    maxImportZipBytes: z.number().int().describe('The largest zip of an import, in bytes'),
    maxImportBytes: z.number().int().describe('The most bytes of zips one import takes, all its zips together'),
    maxImportFileBytes: z.number().int().describe('The largest file inside a zip that an import takes as an attachment, in bytes: not the editor\'s upload limit (`maxAttachmentBytes`), which does not apply to an import'),
    maxMarkdownBytes: z.number().int().describe('The largest Markdown of one page, in bytes (the configured seed cap): a page over it is refused, and the import report names it for a page it skipped'),
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
  const deps = c.get('deps');
  const { config, log } = deps;
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
      providerBaseUrl: deps.providerBaseUrl ?? null,
      fileStoreOrigin: config.files?.publicOrigin ?? null,
      maxAttachmentBytes: config.files?.maxBytes ?? null,
      pendingUploadsMax: config.files?.pendingMaxPerUser ?? null,
      maxMarkdownBytes: config.collab.seedMaxMarkdownBytes,
      maxImportZips: config.import.maxZips,
      maxImportZipBytes: config.import.maxZipBytes,
      maxImportBytes: config.import.maxTotalBytes,
      maxImportFileBytes: config.import.maxEntryBytes,
    },
    200,
  );
});

export default router;
