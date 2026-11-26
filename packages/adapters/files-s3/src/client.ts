import { S3Client } from '@aws-sdk/client-s3';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { FilesConfig } from '@tektum/grimoire-core/ports/config';

type CredentialProvider = ReturnType<typeof defaultProvider>;
type Credentials = Awaited<ReturnType<CredentialProvider>>;

/**
 * How long temporary credentials must still be valid when a URL is signed with them: the longest signed URL (an upload part, 15 minutes) and a minute more. The SDK
 * serves cached credentials until about 5 minutes before they expire, so a URL signed then could outlive them and S3 would refuse the upload with `ExpiredToken`
 * while the API still reports the URL as valid.
 */
export const MIN_CREDENTIAL_LIFETIME_MS = 16 * 60_000;

/**
 * The default credential chain (the task role on Fargate), made safe for signing URLs: when the credentials it holds expire within `MIN_CREDENTIAL_LIFETIME_MS` it
 * is asked for fresh ones, and the SDK is told the credentials expire that much earlier, so it asks again in time. Credentials that never expire are passed on as they are.
 * When the source itself only has short-lived credentials to give, or refreshing them fails, the credentials in hand are used (nothing better exists); a URL signed then can still outlive them.
 */
export function signingCredentials(chain: CredentialProvider, now: () => number = Date.now): CredentialProvider {
  return async (properties) => {
    let credentials: Credentials = await chain(properties);
    if (credentials.expiration !== undefined && credentials.expiration.getTime() - now() < MIN_CREDENTIAL_LIFETIME_MS) {
      // A failed refresh (a transient error of the credential endpoint) must not fail a request the credentials in hand can still serve: they are valid for a while yet.
      credentials = await chain({ ...properties, forceRefresh: true }).catch(() => credentials);
    }
    return credentials.expiration === undefined ? credentials : { ...credentials, expiration: new Date(credentials.expiration.getTime() - MIN_CREDENTIAL_LIFETIME_MS) };
  };
}

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
    // Both keys: a store with its own identity (local development). Neither: the default credential chain, which on Fargate is the task role.
    credentials: config.accessKey !== undefined && config.secretKey !== undefined
      ? { accessKeyId: config.accessKey, secretAccessKey: config.secretKey }
      : signingCredentials(defaultProvider()),
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
