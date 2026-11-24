import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { databaseUrl, RDS_CA_BUNDLE } from '../../../infra/stack/database-url.ts';

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

test('the image holds the bundle where the deployment says (the Dockerfile fetches it with a pinned checksum into /app/certs, readable by the non-root user the server runs as)', async () => {
  const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /ADD --chmod=644 --checksum=sha256:[0-9a-f]{64} https:\/\/truststore\.pki\.rds\.amazonaws\.com\/global\/global-bundle\.pem \/rds\/global-bundle\.pem/);
  assert.match(dockerfile, /mkdir \/out\/certs; install -m 0644 \/rds\/global-bundle\.pem \/out\/certs\/global-bundle\.pem; test "\$\(stat -c %a \/out\/certs\/global-bundle\.pem\)" = 644;/);
  assert.equal(RDS_CA_BUNDLE, '/app/certs/global-bundle.pem');
});

test('the staging step makes the bundle readable by the user the server runs as, whatever mode ADD gave the downloaded file (it writes 0600)', () => {
  const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');
  const step = /mkdir \/out\/certs; (install -m 0644 [^;]+); (test [^;]+);/.exec(dockerfile);
  assert.ok(step, 'the install and the check are in the Dockerfile');
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'grimoire-certs-'));
  try {
    mkdirSync(join(dir, 'rds')); mkdirSync(join(dir, 'out/certs'), { recursive: true });
    writeFileSync(join(dir, 'rds/global-bundle.pem'), 'x', { mode: 0o600 });
    const run = (command) => execFileSync('bash', ['-c', command.replaceAll('/rds/', `${dir}/rds/`).replaceAll('/out/', `${dir}/out/`)]);
    run(step[1]);
    run(step[2]); // the check of the build: it passes on the installed file
    assert.equal(statSync(join(dir, 'out/certs/global-bundle.pem')).mode & 0o777, 0o644);
    chmodSync(join(dir, 'out/certs/global-bundle.pem'), 0o600);
    assert.throws(() => run(step[2]), 'and it fails on a file only its owner can read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
