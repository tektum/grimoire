import { createBucket, deleteBucket, putBucketCors } from '@tektum/grimoire-adapter-files-s3';
import { randomUUID } from 'node:crypto';
import { compose } from '../../support.ts';
import { pngBytes, publicEndpoint, runtimeStore, scenario, setting } from '../support.ts';

// The key the running application holds can read, write and list the one bucket and nothing more (R2.35, the two credentials): it cannot make a bucket, set the CORS rule
// of one, or touch the objects of another bucket. The administrator's key (this test holds it, the application never does) makes the second bucket and removes it again.
const endpoint = setting('GRIMOIRE_S3_ENDPOINT', 'http://127.0.0.1:8333');
const admin = { endpoint, region: 'us-east-1', addressing: 'path' as const, accessKey: setting('GRIMOIRE_DEV_S3_ACCESS_KEY'), secretKey: setting('GRIMOIRE_DEV_S3_SECRET_KEY'), allowedOrigins: [publicEndpoint] };
const runtime = { ...admin, accessKey: setting('GRIMOIRE_S3_ACCESS_KEY'), secretKey: setting('GRIMOIRE_S3_SECRET_KEY') };
const refused = (run: () => Promise<unknown>): Promise<boolean> => run().then(() => false, () => true);

await scenario('scoped-key', 120_000, async (t) => { // timeout: about ten requests to the store
  const other = `e2e-${randomUUID().slice(0, 8)}`;
  t.onDone(async () => { await deleteBucket({ ...admin, bucket: other }).catch(() => undefined); });
  await createBucket({ ...admin, bucket: other });

  const bytes = pngBytes();
  const key = `e2e/${randomUUID()}`;
  const own = runtimeStore();
  await own.put(key, bytes, { size: bytes.length, contentType: 'image/png' });
  t.equal((await own.head(key)).size, bytes.length, 'the runtime key writes and reads its own bucket');
  await own.delete(key);

  t.equal(await refused(() => createBucket({ ...runtime, bucket: `e2e-${randomUUID().slice(0, 8)}` })), true, 'the runtime key cannot create a bucket');
  t.equal(await refused(() => putBucketCors({ ...runtime, bucket: setting('GRIMOIRE_S3_BUCKET', 'grimoire') })), true, 'the runtime key cannot set the CORS rule of its own bucket');
  const foreign = runtimeStore(other);
  t.equal(await refused(() => foreign.put(key, bytes, { size: bytes.length, contentType: 'image/png' })), true, 'the runtime key cannot write into another bucket');

  // The application's own settings, as Compose resolves them for the running service: no administrator key, under any name, and not the administrator's value.
  const resolved = JSON.parse(await compose('config', '--format', 'json')) as { services: { app: { environment: Record<string, string | null> } } };
  const environment = resolved.services.app.environment;
  t.equal(Object.keys(environment).filter((name) => /ADMIN_(ACCESS|SECRET)_KEY/.test(name)), [], 'the app service has no administrator key setting');
  t.equal(Object.values(environment).filter((value) => value === admin.accessKey || value === admin.secretKey), [], 'and none of its settings holds the administrator key');
  t.equal(environment['GRIMOIRE_S3_ACCESS_KEY'], runtime.accessKey, 'it holds the runtime key');
});
