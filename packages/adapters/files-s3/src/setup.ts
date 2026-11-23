import {
  CreateBucketCommand,
  DeleteBucketCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  S3Client,
  type BucketLocationConstraint,
  type CORSRule,
} from '@aws-sdk/client-s3';
import { mapError } from './errors.js';

/** What setting the store up needs: the admin identity (the running server never holds it) and the origins. */
export interface EnsureBucketOptions {
  readonly endpoint: string;
  /** What browsers use (a path prefix included); `checkCors` asks it, `endpoint` when unset. */
  readonly publicEndpoint?: string;
  /** Milliseconds `checkCors` waits for one preflight; ten seconds when unset. */
  readonly timeoutMs?: number;
  readonly bucket: string;
  readonly region: string;
  readonly addressing: 'path' | 'virtual';
  readonly accessKey: string;
  readonly secretKey: string;
  /** Origins of the web application: `GRIMOIRE_ALLOWED_ORIGINS`. */
  readonly allowedOrigins: readonly string[];
  /** The create-only header of the store setting: the browser sends it, so the CORS rule must allow it. */
  readonly createOnlyHeader?: string;
}

const client = (o: EnsureBucketOptions): S3Client =>
  new S3Client({
    endpoint: o.endpoint,
    region: o.region,
    forcePathStyle: o.addressing === 'path',
    credentials: { accessKeyId: o.accessKey, secretAccessKey: o.secretKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 1,
  });

/** Creates the bucket; a bucket the caller already owns counts as success. */
export async function createBucket(o: EnsureBucketOptions): Promise<void> {
  const s3 = client(o);
  try {
    // Outside us-east-1 a store (or AWS) refuses the call without the region as the location.
    await s3.send(
      new CreateBucketCommand({
        Bucket: o.bucket,
        ...(o.region === 'us-east-1'
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: o.region as BucketLocationConstraint } }),
      }),
    );
  } catch (error) {
    if ((error as { name?: unknown }).name === 'BucketAlreadyOwnedByYou') return;
    throw mapError(error);
  } finally {
    s3.destroy();
  }
}

/** Replaces the CORS rule of the bucket: `GET`, `PUT` and `HEAD` from the application's origins, for ten minutes. */
export async function putBucketCors(o: EnsureBucketOptions): Promise<void> {
  const headers = ['content-type', 'content-disposition', 'if-none-match', 'x-amz-*'];
  if (o.createOnlyHeader !== undefined && !headers.includes(o.createOnlyHeader)) headers.push(o.createOnlyHeader);
  const s3 = client(o);
  try {
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: o.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [...o.allowedOrigins],
              AllowedMethods: ['GET', 'PUT', 'HEAD'],
              AllowedHeaders: headers,
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 600,
            },
          ],
        },
      }),
    );
  } catch (error) {
    throw mapError(error);
  } finally {
    s3.destroy();
  }
}

/** The set-up step: the bucket exists and its CORS rule is the one above. Safe to run again. */
export async function ensureBucket(o: EnsureBucketOptions): Promise<void> {
  await createBucket(o);
  await putBucketCors(o);
}

/** The CORS rules the bucket has now (for the set-up check and for tests); an absent bucket is `unavailable`. */
export async function readBucketCors(o: EnsureBucketOptions): Promise<CORSRule[]> {
  const s3 = client(o);
  try {
    return (await s3.send(new GetBucketCorsCommand({ Bucket: o.bucket }))).CORSRules ?? [];
  } catch (error) {
    throw mapError(error);
  } finally {
    s3.destroy();
  }
}

/** Removes an empty bucket: for tests and tooling that made their own; the server and the set-up step never call it. */
export async function deleteBucket(o: EnsureBucketOptions): Promise<void> {
  const s3 = client(o);
  try {
    await s3.send(new DeleteBucketCommand({ Bucket: o.bucket }));
  } catch (error) {
    throw mapError(error);
  } finally {
    s3.destroy();
  }
}

export type CorsCheck = { readonly ok: true } | { readonly ok: false; readonly problem: string };

/** The key the preflights ask about; no object needs to exist for a preflight. */
const PROBE_KEY = 'attachments/cors-probe';

const listOf = (value: string | null): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');

/** The address of the probe object on the endpoint browsers use, in the addressing style of the setting, prefix kept. */
export function corsProbeUrl(o: EnsureBucketOptions): string {
  const url = new URL(o.publicEndpoint ?? o.endpoint);
  const prefix = url.pathname.replace(/\/+$/, '');
  if (o.addressing === 'virtual') {
    url.hostname = `${o.bucket}.${url.hostname}`;
    url.pathname = `${prefix}/${PROBE_KEY}`;
  } else {
    url.pathname = `${prefix}/${o.bucket}/${PROBE_KEY}`;
  }
  return url.toString();
}

/**
 * For a store whose CORS an operator sets (`external` mode): sends the preflights a browser would send, for each
 * allowed origin on the upload path (`PUT` with `content-type`, `content-disposition` and the create-only header) and
 * the download path (`GET` and `HEAD`), and names the first origin, method or header the answers do not allow.
 * Sends no key and writes nothing.
 */
export async function checkCors(o: EnsureBucketOptions): Promise<CorsCheck> {
  const url = corsProbeUrl(o);
  const createOnly = (o.createOnlyHeader ?? 'if-none-match').toLowerCase();
  const probes = [
    { method: 'PUT', headers: ['content-type', 'content-disposition', createOnly] },
    { method: 'GET', headers: [] },
    { method: 'HEAD', headers: [] },
  ];
  for (const origin of o.allowedOrigins) {
    for (const probe of probes) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'OPTIONS',
          signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
          headers: {
            origin,
            'access-control-request-method': probe.method,
            ...(probe.headers.length > 0 ? { 'access-control-request-headers': probe.headers.join(',') } : {}),
          },
        });
      } catch {
        throw mapError(undefined);
      }
      const allowedOrigin = response.headers.get('access-control-allow-origin');
      if (!response.ok || (allowedOrigin !== origin && allowedOrigin !== '*')) {
        return { ok: false, problem: `origin ${origin} is not allowed` };
      }
      const methods = listOf(response.headers.get('access-control-allow-methods'));
      if (!methods.includes(probe.method.toLowerCase()) && !methods.includes('*')) {
        return { ok: false, problem: `method ${probe.method} is not allowed for origin ${origin}` };
      }
      const headers = listOf(response.headers.get('access-control-allow-headers'));
      for (const header of probe.headers) {
        if (!headers.includes(header) && !headers.includes('*')) {
          return { ok: false, problem: `header ${header} is not allowed for origin ${origin}` };
        }
      }
    }
  }
  return { ok: true };
}
