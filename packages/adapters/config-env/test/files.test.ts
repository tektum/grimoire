import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';

const key = () => randomBytes(12).toString('hex'); // generated per run: no secret-looking literal in the repository
const base = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: key() + key(),
  GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
};
const store = {
  GRIMOIRE_S3_ENDPOINT: 'http://seaweedfs:8333',
  GRIMOIRE_S3_BUCKET: 'grimoire',
  GRIMOIRE_S3_ACCESS_KEY: key(),
  GRIMOIRE_S3_SECRET_KEY: key(),
};
const load = (extra: Record<string, string> = {}, local = true) =>
  loadConfig({ ...base, ...store, ...extra, ...(local ? {} : { GRIMOIRE_LOCAL: '0', GRIMOIRE_DESCOPE_PROJECT_ID: 'P123', GRIMOIRE_FIRST_ADMIN_EMAILS: 'a@example.com', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.com' }) });

function issuesOf(extra: Record<string, string>, local = true): string[] {
  try {
    load(extra, local);
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
}

describe('Config.files', () => {
  it('is absent when no store variable is set', () => {
    expect(loadConfig(base).files).toBeUndefined();
  });

  it('applies the defaults when the store is set', () => {
    const files = load().files;
    expect(files).toMatchObject({
      endpoint: 'http://seaweedfs:8333', publicEndpoint: 'http://seaweedfs:8333', publicOrigin: 'http://seaweedfs:8333',
      region: 'us-east-1', addressing: 'path', createOnlyHeader: 'if-none-match', corsMode: 'api',
      maxBytes: 26_214_400, pendingMaxPerUser: 10,
    });
    expect(files?.allowedTypes).toHaveLength(15);
    expect(files?.allowedTypes).toContain('application/pdf');
  });

  it('takes the public origin from the public endpoint, without its path', () => {
    expect(load({ GRIMOIRE_S3_PUBLIC_ENDPOINT: 'https://files.example.com:9000/x' }).files?.publicOrigin).toBe('https://files.example.com:9000');
  });

  it('reads explicit values', () => {
    const files = load({
      GRIMOIRE_S3_REGION: 'eu-west-1', GRIMOIRE_S3_ADDRESSING_STYLE: 'virtual', GRIMOIRE_FILES_MAX_BYTES: '1000',
      GRIMOIRE_FILES_PENDING_MAX_PER_USER: '3', GRIMOIRE_FILES_ALLOWED_TYPES: 'image/png, application/pdf',
    }).files;
    expect(files).toMatchObject({ region: 'eu-west-1', addressing: 'virtual', maxBytes: 1000, pendingMaxPerUser: 3, allowedTypes: ['image/png', 'application/pdf'] });
  });

  it.each(['GRIMOIRE_FILES_MAX_BYTES', 'GRIMOIRE_FILES_PENDING_MAX_PER_USER'])('refuses zero and non-digits for %s, naming it', (name) => {
    for (const bad of ['0', '-1', '1e3', 'x']) expect(issuesOf({ [name]: bad }).join('\n')).toContain(name);
  });

  it.each(['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/javascript', 'application/javascript'])(
    'refuses %s in the allowed types, naming the variable',
    (type) => {
      expect(issuesOf({ GRIMOIRE_FILES_ALLOWED_TYPES: `image/png,${type}` }).join('\n')).toContain('GRIMOIRE_FILES_ALLOWED_TYPES');
    },
  );

  it.each(['image', 'image/', 'Image/PNG', 'image/png;charset=x', ','])('refuses the malformed type list %j', (value) => {
    expect(issuesOf({ GRIMOIRE_FILES_ALLOWED_TYPES: value }).join('\n')).toContain('GRIMOIRE_FILES_ALLOWED_TYPES');
  });

  it('refuses a public endpoint whose origin is an allowed app origin', () => {
    const issues = issuesOf({ GRIMOIRE_S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:8080/files' });
    expect(issues.join('\n')).toContain('GRIMOIRE_S3_PUBLIC_ENDPOINT');
    expect(issuesOf({ GRIMOIRE_S3_PUBLIC_ENDPOINT: 'http://localhost:8333' })).toEqual([]);
  });
});

describe('admin keys', () => {
  const admin = { GRIMOIRE_S3_ADMIN_ACCESS_KEY: key(), GRIMOIRE_S3_ADMIN_SECRET_KEY: key() };

  it('are accepted in local mode and never appear in Config.files', () => {
    const files = load(admin).files;
    expect(JSON.stringify(files)).not.toContain(admin.GRIMOIRE_S3_ADMIN_ACCESS_KEY);
    expect(JSON.stringify(files)).not.toContain(admin.GRIMOIRE_S3_ADMIN_SECRET_KEY);
  });

  it('are refused for the server outside local mode', () => {
    expect(issuesOf(admin, false).join('\n')).toContain('GRIMOIRE_S3_ADMIN_ACCESS_KEY');
    expect(issuesOf({}, false)).toEqual([]);
  });

  it('must come as a pair', () => {
    expect(issuesOf({ GRIMOIRE_S3_ADMIN_ACCESS_KEY: key() }).join('\n')).toContain('GRIMOIRE_S3_ADMIN_SECRET_KEY');
    expect(issuesOf({ GRIMOIRE_S3_ADMIN_SECRET_KEY: key() }).join('\n')).toContain('GRIMOIRE_S3_ADMIN_ACCESS_KEY');
  });
});
