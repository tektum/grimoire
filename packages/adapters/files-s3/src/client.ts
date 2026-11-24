import { S3Client } from '@aws-sdk/client-s3';
import type { FilesConfig } from '@tektum/grimoire-core/ports/config';

/**
 * One client talks to the internal endpoint; a second one is bound to the public endpoint and is used only to
 * sign URLs, so that a signed URL carries the host the browser reaches. Checksums are computed and validated only
 * where the protocol requires them: a streamed body is sent as it is, with no trailer a store may not know.
 */
export function createClients(
  config: FilesConfig,
  options: { readonly maxAttempts?: number } = {},
): { client: S3Client; signer: S3Client } {
  const shared = {
    region: config.region,
    forcePathStyle: config.addressing === 'path',
    // Both keys: a store with its own identity (local development). Neither: the SDK's default credential chain, which on Fargate is the task role.
    ...(config.accessKey !== undefined && config.secretKey !== undefined ? { credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey } } : {}),
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    responseChecksumValidation: 'WHEN_REQUIRED' as const,
  };
  return {
    client: new S3Client({
      ...shared,
      endpoint: config.endpoint,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    }),
    signer: new S3Client({ ...shared, endpoint: config.publicEndpoint }),
  };
}
