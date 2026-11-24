import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

const key = () => randomBytes(12).toString('hex'); // generated per run: no secret-looking literal in the repository
const base = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: key() + key(),
  GRIMOIRE_DATABASE_URL: placeholderDatabaseUrl(),
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
    // Virtual addressing puts the bucket in the host the browser calls, and the content security policy and the client's file-store origin must name that host.
    const virtual = { GRIMOIRE_S3_ADDRESSING_STYLE: 'virtual', GRIMOIRE_S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com', GRIMOIRE_S3_BUCKET: 'my-bucket' };
    expect(load(virtual).files?.publicOrigin).toBe('https://my-bucket.s3.eu-west-1.amazonaws.com');
    expect(load({ ...virtual, GRIMOIRE_S3_ADDRESSING_STYLE: 'path' }).files?.publicOrigin).toBe('https://s3.eu-west-1.amazonaws.com');
    // Where the SDK falls back to path style (a dotted bucket, an uppercase name, an IP address) the origin stays the endpoint's.
    expect(load({ ...virtual, GRIMOIRE_S3_BUCKET: 'my.bucket' }).files?.publicOrigin).toBe('https://s3.eu-west-1.amazonaws.com');
    expect(load({ ...virtual, GRIMOIRE_S3_BUCKET: 'My_Bucket' }).files?.publicOrigin).toBe('https://s3.eu-west-1.amazonaws.com');
    expect(load({ ...virtual, GRIMOIRE_S3_ENDPOINT: 'https://10.0.0.5:9000' }).files?.publicOrigin).toBe('https://10.0.0.5:9000');
    expect(load({ ...virtual, GRIMOIRE_S3_ENDPOINT: 'http://store.test:9000', GRIMOIRE_S3_BUCKET: 'my.bucket' }).files?.publicOrigin).toBe('http://store.test:9000');
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

  it.each(['application/x-javascript', 'application/ecmascript', 'text/ecmascript', 'text/x-javascript', 'text/javascript1.0', 'text/javascript1.5', 'text/jscript', 'text/livescript', 'application/rss+xml', 'application/atom+xml'])(
    'refuses the script or XML family member %s',
    (type) => {
      expect(issuesOf({ GRIMOIRE_FILES_ALLOWED_TYPES: type }).join('\n')).toContain('GRIMOIRE_FILES_ALLOWED_TYPES');
    },
  );

  it('names the variable for a value with a non-ASCII character (the rule that reads the list must not throw)', () => {
    const issues = issuesOf({ GRIMOIRE_FILES_ALLOWED_TYPES: 'image/pn\u00e9' });
    expect(issues.join('\n')).toContain('GRIMOIRE_FILES_ALLOWED_TYPES');
    expect(issues.join('\n')).not.toContain('could not be validated');
  });

  it.each(['image', 'image/', 'Image/PNG', 'image/png;charset=x', ','])('refuses the malformed type list %j', (value) => {
    expect(issuesOf({ GRIMOIRE_FILES_ALLOWED_TYPES: value }).join('\n')).toContain('GRIMOIRE_FILES_ALLOWED_TYPES');
  });

  it('refuses a public endpoint whose origin is an allowed app origin', () => {
    const issues = issuesOf({ GRIMOIRE_S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:8080/files' });
    expect(issues.join('\n')).toContain('GRIMOIRE_S3_PUBLIC_ENDPOINT');
    expect(issuesOf({ GRIMOIRE_S3_PUBLIC_ENDPOINT: 'http://localhost:8333' })).toEqual([]);
  });

  it('applies the same rule to the internal endpoint when it is the one in use (no public endpoint set)', () => {
    expect(issuesOf({ GRIMOIRE_S3_ENDPOINT: 'http://127.0.0.1:8080/files' }).join('\n')).toContain('GRIMOIRE_S3_ENDPOINT');
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

describe('the files-setup purpose', () => {
  const setupEnv = {
    GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
    GRIMOIRE_S3_ENDPOINT: 'http://seaweedfs:8333',
    GRIMOIRE_S3_BUCKET: 'grimoire',
    GRIMOIRE_S3_ADMIN_ACCESS_KEY: key(),
    GRIMOIRE_S3_ADMIN_SECRET_KEY: key(),
  };
  const issuesFor = (env: Record<string, string>): string[] => {
    try {
      loadConfig(env, { purpose: 'files-setup' });
    } catch (e) {
      if (e instanceof ConfigError) return e.issues;
      throw e;
    }
    return [];
  };

  it('succeeds with the endpoint, bucket, admin keys and allowed origins only (no database, no runtime keys, no local mode)', () => {
    const config = loadConfig(setupEnv, { purpose: 'files-setup' });
    expect(config.filesSetup).toEqual({
      endpoint: 'http://seaweedfs:8333', bucket: 'grimoire', region: 'us-east-1', addressing: 'path', corsMode: 'api', createOnlyHeader: 'if-none-match', publicEndpoint: 'http://seaweedfs:8333',
      accessKey: setupEnv.GRIMOIRE_S3_ADMIN_ACCESS_KEY, secretKey: setupEnv.GRIMOIRE_S3_ADMIN_SECRET_KEY,
    });
    expect(config.allowedOrigins).toEqual(['http://127.0.0.1:8080']);
    expect(config.files).toBeUndefined();
  });

  it('carries the public endpoint, the internal one when it is not set, prefix included', () => {
    const prefixed = { ...setupEnv, GRIMOIRE_S3_PUBLIC_ENDPOINT: 'https://files.example.test/files' };
    expect(loadConfig(prefixed, { purpose: 'files-setup' }).filesSetup?.publicEndpoint).toBe('https://files.example.test/files');
    expect(loadConfig(setupEnv, { purpose: 'files-setup' }).filesSetup?.publicEndpoint).toBe('http://seaweedfs:8333');
  });

  it('carries the create-only header of the setting, which the CORS rule and the external check need', () => {
    for (const header of ['if-none-match', 'x-goog-if-generation-match']) {
      const config = loadConfig({ ...setupEnv, GRIMOIRE_S3_CREATE_ONLY_HEADER: header }, { purpose: 'files-setup' });
      expect(config.filesSetup?.createOnlyHeader).toBe(header);
    }
    expect(issuesFor({ ...setupEnv, GRIMOIRE_S3_CREATE_ONLY_HEADER: 'x-other' }).join('\n')).toContain('GRIMOIRE_S3_CREATE_ONLY_HEADER');
  });

  it.each(['GRIMOIRE_ALLOWED_ORIGINS', 'GRIMOIRE_S3_ENDPOINT', 'GRIMOIRE_S3_BUCKET', 'GRIMOIRE_S3_ADMIN_ACCESS_KEY', 'GRIMOIRE_S3_ADMIN_SECRET_KEY'])(
    'fails without %s, naming it',
    (name) => {
      const rest: Record<string, string> = { ...setupEnv };
      delete rest[name];
      expect(issuesFor(rest).join('\n')).toContain(name);
    },
  );

  it('does not need the runtime keys, and the server purpose still does not accept the admin key outside local mode', () => {
    expect(issuesFor(setupEnv)).toEqual([]);
    expect(issuesOf({ GRIMOIRE_S3_ADMIN_ACCESS_KEY: key(), GRIMOIRE_S3_ADMIN_SECRET_KEY: key() }, false).join('\n')).toContain('GRIMOIRE_S3_ADMIN_ACCESS_KEY');
  });

  it('does not build Config.filesSetup for the server purpose', () => {
    expect(load({ GRIMOIRE_S3_ADMIN_ACCESS_KEY: key(), GRIMOIRE_S3_ADMIN_SECRET_KEY: key() }).filesSetup).toBeUndefined();
  });

  it('refuses an allowed app origin equal to the file origin the browsers will use, in virtual style the one with the bucket in the host', () => {
    const virtual = { GRIMOIRE_S3_ADDRESSING_STYLE: 'virtual', GRIMOIRE_S3_ENDPOINT: 'https://s3.example.test', GRIMOIRE_S3_BUCKET: 'app', GRIMOIRE_ALLOWED_ORIGINS: 'https://app.s3.example.test' };
    expect(issuesOf(virtual).join('\n')).toContain('different from every origin');
    expect(issuesOf({ ...virtual, GRIMOIRE_S3_ADDRESSING_STYLE: 'path' })).toEqual([]); // path style: the file origin is s3.example.test, another one
  });
});
