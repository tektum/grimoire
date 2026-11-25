import { expect, test } from '@playwright/test';
import { recreateEnv } from './stack';

// The environment a recreated app gets (no docker, no stack): the address of the file store survives a recreate, and a setting given wins.
test('a recreate keeps the address the browser reaches the file store at, and a setting of the spec overrides', () => {
  const saved = process.env['GRIMOIRE_S3_PUBLIC_ENDPOINT'];
  const savedOrigin = process.env['E2E_STORE_ORIGIN'];
  try {
    delete process.env['GRIMOIRE_S3_PUBLIC_ENDPOINT'];
    delete process.env['E2E_STORE_ORIGIN'];
    expect(recreateEnv().GRIMOIRE_S3_PUBLIC_ENDPOINT).toBe('http://127.0.0.1:8333');
    expect(recreateEnv().COMPOSE_FILE).toBe('compose.yaml:compose.m6.yaml');
    process.env['E2E_STORE_ORIGIN'] = 'http://127.0.0.1:9000';
    expect(recreateEnv().GRIMOIRE_S3_PUBLIC_ENDPOINT).toBe('http://127.0.0.1:9000');
    process.env['GRIMOIRE_S3_PUBLIC_ENDPOINT'] = 'http://127.0.0.1:1111';
    expect(recreateEnv().GRIMOIRE_S3_PUBLIC_ENDPOINT).toBe('http://127.0.0.1:1111');
    expect(recreateEnv({ M6_RECHECK_SECONDS: '5' }).M6_RECHECK_SECONDS).toBe('5');
    expect(recreateEnv({ GRIMOIRE_S3_PUBLIC_ENDPOINT: 'http://other:1' }).GRIMOIRE_S3_PUBLIC_ENDPOINT).toBe('http://other:1');
  } finally {
    if (saved === undefined) delete process.env['GRIMOIRE_S3_PUBLIC_ENDPOINT'];
    else process.env['GRIMOIRE_S3_PUBLIC_ENDPOINT'] = saved;
    if (savedOrigin === undefined) delete process.env['E2E_STORE_ORIGIN'];
    else process.env['E2E_STORE_ORIGIN'] = savedOrigin;
  }
});
