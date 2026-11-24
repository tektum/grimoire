import { randomBytes } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@tektum/grimoire-adapter-config-env';

const key = () => randomBytes(12).toString('hex'); // generated per run: no secret-looking literal in the repository

/** The origin the real SDK puts a presigned URL on, for the same endpoint and bucket, with virtual addressing (what the server's file store client does). */
async function presignedOrigin(endpoint: string, bucket: string): Promise<string> {
  const client = new S3Client({ region: 'eu-west-1', endpoint, forcePathStyle: false, credentials: { accessKeyId: key(), secretAccessKey: key() } });
  return new URL(await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: 'a' }), { expiresIn: 60 })).origin;
}

const configuredOrigin = (endpoint: string, bucket: string): string | undefined =>
  loadConfig({
    GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: key() + key(), GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire', GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
    GRIMOIRE_S3_ENDPOINT: endpoint, GRIMOIRE_S3_BUCKET: bucket, GRIMOIRE_S3_ADDRESSING_STYLE: 'virtual', GRIMOIRE_S3_ACCESS_KEY: key(), GRIMOIRE_S3_SECRET_KEY: key(),
  }).files?.publicOrigin;

describe('the file store origin of the configuration is the one the SDK presigns on, in virtual style', () => {
  it.each([
    ['https://s3.eu-west-1.amazonaws.com', 'my-bucket'],
    ['https://s3.eu-west-1.amazonaws.com', 'my.bucket'],
    ['https://s3.eu-west-1.amazonaws.com', 'My_Bucket'],
    ['https://s3.eu-west-1.amazonaws.com', 'ab'],
    ['https://10.0.0.5:9000', 'my-bucket'],
    ['https://store.example.test:9000', 'my-bucket'],
    ['http://store.example.test:9000', 'my.bucket'],
    ['http://store.example.test:9000', 'my-bucket'],
  ])('%s with the bucket %s', async (endpoint, bucket) => {
    expect(configuredOrigin(endpoint, bucket)).toBe(await presignedOrigin(endpoint, bucket));
  });
});
