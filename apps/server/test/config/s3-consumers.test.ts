import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// No store setting is left unread: every `GRIMOIRE_S3_*` and `GRIMOIRE_FILES_*` name of the settings schema is read
// by the server or by the file store adapter, through the field of `Config.files` it fills. A setting whose reader is
// a later piece of work is named in `notReadYet` with that piece; the test fails when such a setting gains a reader,
// so the list only shrinks.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const schemaFile = path.join(root, 'packages/adapters/config-env/src/schema.ts');
/**
 * The admin key is read nowhere but by the files-setup command, whose composition hands the whole `Config.filesSetup`
 * (with both keys) to the store set-up; `composition.ts` is its one allowed reader.
 */
const adminKeyReader = path.join(root, 'apps/server/src/composition.ts');
const adminKeys = ['GRIMOIRE_S3_ADMIN_ACCESS_KEY', 'GRIMOIRE_S3_ADMIN_SECRET_KEY'];
const readerDirs = [path.join(root, 'apps/server/src'), path.join(root, 'packages/adapters/files-s3/src')];

/** The `Config.files` field each setting fills. */
const fieldOf: Record<string, string> = {
  GRIMOIRE_S3_ENDPOINT: 'endpoint',
  GRIMOIRE_S3_PUBLIC_ENDPOINT: 'publicEndpoint',
  GRIMOIRE_S3_BUCKET: 'bucket',
  GRIMOIRE_S3_ACCESS_KEY: 'accessKey',
  GRIMOIRE_S3_SECRET_KEY: 'secretKey',
  GRIMOIRE_S3_REGION: 'region',
  GRIMOIRE_S3_ADDRESSING_STYLE: 'addressing',
  GRIMOIRE_S3_CREATE_ONLY_HEADER: 'createOnlyHeader',
  GRIMOIRE_S3_CORS_MODE: 'corsMode',
  GRIMOIRE_S3_ADMIN_ACCESS_KEY: 'accessKey',
  GRIMOIRE_S3_ADMIN_SECRET_KEY: 'secretKey',
  GRIMOIRE_FILES_MAX_BYTES: 'maxBytes',
  GRIMOIRE_FILES_ALLOWED_TYPES: 'allowedTypes',
  GRIMOIRE_FILES_PENDING_MAX_PER_USER: 'pendingMaxPerUser',
};

/** Settings read by a piece of work that has not landed. */
const notReadYet: Record<string, string> = {};

/** Whether some source reads `field` from a files configuration (`config.field`, `config.files.field`, `files?.field`, `setup.field`). */
export function hasReader(sources: readonly string[], field: string): boolean {
  const read = new RegExp(`\\b(?:config|files|setup)\\??\\.(?:files\\??\\.)?${field}\\b`);
  return sources.some((source) => read.test(source));
}

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourcesUnder(full);
    return /\.ts$/.test(entry.name) ? [readFileSync(full, 'utf8')] : [];
  });
}

const schemaSource = readFileSync(schemaFile, 'utf8');
const settings = [
  ...new Set([...schemaSource.matchAll(/^\s*(GRIMOIRE_(?:S3|FILES)_[A-Z0-9_]+):/gm)].map((m) => m[1] as string)),
];
const sources = readerDirs.flatMap(sourcesUnder);

describe('the store settings and their readers', () => {
  it('finds the settings of the schema', () => {
    expect(settings.length).toBeGreaterThanOrEqual(14);
  });

  it('knows the field of every setting', () => {
    expect(settings.filter((name) => fieldOf[name] === undefined)).toEqual([]);
    expect(Object.keys(fieldOf).filter((name) => !settings.includes(name))).toEqual([]);
  });

  it.each(settings.filter((name) => notReadYet[name] === undefined && !adminKeys.includes(name)))(
    '%s has a reader',
    (name) => {
      expect(hasReader(sources, fieldOf[name] as string)).toBe(true);
    },
  );

  it.each(adminKeys)('%s is read by the files-setup composition, and by nothing else', (name) => {
    expect(settings).toContain(name);
    const composition = readFileSync(adminKeyReader, 'utf8');
    expect(composition).toMatch(/\.\.\.setup\b/);
    expect(composition).not.toContain(name); // through Config.filesSetup, never by name
    for (const other of readerDirs.flatMap(sourcesUnder)) expect(other).not.toContain(name);
  });

  it.each(Object.keys(notReadYet))('%s is still waiting for its reader, which the list must then drop', (name) => {
    expect(settings).toContain(name);
    // The two admin keys and the other fields are read through other names too, so only a field of its own counts.
    const own = !['accessKey', 'secretKey'].includes(fieldOf[name] as string);
    if (own) expect(hasReader(sources, fieldOf[name] as string)).toBe(false);
  });

  it('sees a reader and sees its absence', () => {
    expect(hasReader(['const x = config.files?.maxBytes;'], 'maxBytes')).toBe(true);
    expect(hasReader(['return files.maxBytes + 1'], 'maxBytes')).toBe(true);
    expect(hasReader(['this.config.bucket'], 'bucket')).toBe(true);
    expect(hasReader(['const maxBytes = 5; other.maxBytes2'], 'maxBytes')).toBe(false);
    expect(hasReader([], 'maxBytes')).toBe(false);
  });
});
