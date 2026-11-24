import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { databaseUrl, RDS_CA_BUNDLE } from '../../../infra/staging/database-url.ts';

const { parse } = createRequire(import.meta.url)('pg-connection-string');
const url = databaseUrl('grimoire_app', 'p@ss/word:1', 'db.cluster-x.eu-west-1.rds.amazonaws.com', 5432, 'grimoire');

test('the connection string asks the driver to verify the server: a certificate chain and the host name, never merely encryption', () => {
  const config = parse(url);
  assert.ok(config.ssl, 'ssl is on');
  assert.notEqual(config.ssl.rejectUnauthorized, false, 'the certificate is checked');
  assert.equal(new URL(url).searchParams.get('sslmode'), 'verify-full');
  assert.ok(!/no-verify|sslmode=(?:disable|allow|prefer|require)\b/.test(url));
});

test('the parts survive: user, password with reserved characters, host, port and database', () => {
  const config = parse(url);
  assert.deepEqual([config.user, config.password, config.host, config.port, config.database], ['grimoire_app', 'p@ss/word:1', 'db.cluster-x.eu-west-1.rds.amazonaws.com', '5432', 'grimoire']);
});

test('the image holds the bundle where the deployment says (the Dockerfile fetches it with a pinned checksum into /app/certs)', async () => {
  const { readFileSync } = await import('node:fs');
  const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /ADD --checksum=sha256:[0-9a-f]{64} https:\/\/truststore\.pki\.rds\.amazonaws\.com\/global\/global-bundle\.pem \/rds\/global-bundle\.pem/);
  assert.match(dockerfile, /mkdir \/out\/certs; cp \/rds\/global-bundle\.pem \/out\/certs\//);
  assert.equal(RDS_CA_BUNDLE, '/app/certs/global-bundle.pem');
});
