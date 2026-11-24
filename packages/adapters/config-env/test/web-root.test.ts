import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';

const problems = (env: Record<string, string>, purpose: 'server' | 'migrate' = 'server'): string[] => {
  try { loadConfig(env, { purpose }); return []; } catch (e) { if (e instanceof ConfigError) return e.problems.map((p) => `${p.setting}: ${p.rule}`); throw e; }
};

describe('GRIMOIRE_WEB_ROOT', () => {
  const server = { GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: 'dev-token-secret-0123456789', GRIMOIRE_DATABASE_URL: 'postgresql://a:b@h/grimoire', GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080' };
  const web = { ...server, GRIMOIRE_WEB_ROOT: '/app/web', GRIMOIRE_PUBLIC_API_URL: 'https://app.example.test', GRIMOIRE_PUBLIC_COLLAB_URL: 'wss://app.example.test/collab', GRIMOIRE_S3_ENDPOINT: 'https://s3.example.test', GRIMOIRE_S3_BUCKET: 'b' };

  it('is carried with the public addresses when everything it needs is set, and absent otherwise', () => {
    const config = loadConfig(web, { purpose: 'server' });
    expect([config.webRoot, config.publicApiUrl, config.publicCollabUrl]).toEqual(['/app/web', 'https://app.example.test', 'wss://app.example.test/collab']);
    expect(loadConfig(server, { purpose: 'server' }).webRoot).toBeUndefined();
  });

  it.each([
    ['GRIMOIRE_PUBLIC_API_URL', 'is required when GRIMOIRE_WEB_ROOT is set'],
    ['GRIMOIRE_PUBLIC_COLLAB_URL', 'is required when GRIMOIRE_WEB_ROOT is set'],
    ['GRIMOIRE_S3_ENDPOINT', 'is required when GRIMOIRE_WEB_ROOT is set'],
  ])('refuses a web root without %s', (name, rule) => {
    const without = Object.entries(web).filter(([key]) => key !== name && (name !== 'GRIMOIRE_S3_ENDPOINT' || key !== 'GRIMOIRE_S3_BUCKET'));
    const found = problems(Object.fromEntries(without), 'server');
    expect(found.some((p) => p.startsWith(`${name}: ${rule}`)), found.join(' | ')).toBe(true);
  });

  it('must be an absolute path', () => {
    expect(problems({ ...web, GRIMOIRE_WEB_ROOT: 'web' }, 'server')).toEqual(['GRIMOIRE_WEB_ROOT: must be an absolute path']);
  });
});
