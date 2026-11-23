import { CreateBucketCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { mapError } from './errors.js';

/** What setting the store up needs: the admin identity (the running server never holds it) and the origins. */
export interface EnsureBucketOptions {
  readonly endpoint: string;
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
    await s3.send(new CreateBucketCommand({ Bucket: o.bucket }));
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
