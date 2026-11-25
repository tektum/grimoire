import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

// M7-T00 (contracts section 6): the import, jobs and search settings. Every default, every refusal names its variable. There is no limit on the size of a Markdown file here:
// the importer uses the seed and state caps the server already has (decision 10).
const key = () => randomBytes(12).toString('hex'); // generated per run: no secret-looking literal in the repository
const base = { GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: key() + key(), GRIMOIRE_DATABASE_URL: placeholderDatabaseUrl(), GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080' };
const load = (extra: Record<string, string> = {}) => loadConfig({ ...base, ...extra });
const issuesOf = (extra: Record<string, string>): string[] => {
  try { load(extra); } catch (e) { if (e instanceof ConfigError) return e.issues; throw e; }
  return [];
};

describe('the defaults', () => {
  it('are the ones of the contracts', () => {
    const c = load();
    expect(c.import).toEqual({
      maxZipBytes: 524_288_000, maxEntries: 20_000, maxUncompressedBytes: 2_147_483_648, maxRatio: 100, maxEntryBytes: 104_857_600, maxTableBytes: 262_144, allowNestedZips: false,
      fetchRemoteImages: true, remote: { maxImages: 200, maxBytes: 20_971_520, timeoutSeconds: 10, totalSeconds: 300 }, concurrency: 2, converterThreads: 1,
    });
    expect(c.jobs).toEqual({ importExpireSeconds: 900, stopGraceMs: 15_000, purgeCron: '17 3 * * *', uploadCleanupCron: '*/15 * * * *', revisionCron: '47 3 * * *', sweepCron: '*/5 * * * *' });
    expect(c.search).toEqual({ statementTimeoutMs: 3000 });
  });

  it('are changed by the variables', () => {
    const c = load({ GRIMOIRE_IMPORT_MAX_ENTRIES: '50', GRIMOIRE_IMPORT_ALLOW_NESTED_ZIPS: '1', GRIMOIRE_IMPORT_FETCH_REMOTE_IMAGES: '0', GRIMOIRE_IMPORT_REMOTE_MAX_IMAGES: '3', GRIMOIRE_JOBS_PURGE_CRON: '5 4 * * 1', GRIMOIRE_SEARCH_STATEMENT_TIMEOUT_MS: '500' });
    expect([c.import.maxEntries, c.import.allowNestedZips, c.import.fetchRemoteImages, c.import.remote.maxImages, c.jobs.purgeCron, c.search.statementTimeoutMs]).toEqual([50, true, false, 3, '5 4 * * 1', 500]);
  });
});

describe('the refusals name the variable', () => {
  it.each([
    ['GRIMOIRE_IMPORT_MAX_RATIO', '0'], ['GRIMOIRE_IMPORT_MAX_ZIP_BYTES', '0'], ['GRIMOIRE_IMPORT_MAX_ENTRIES', '-1'], ['GRIMOIRE_IMPORT_MAX_ENTRY_BYTES', '1.5'],
    ['GRIMOIRE_IMPORT_ALLOW_NESTED_ZIPS', 'yes'], ['GRIMOIRE_IMPORT_FETCH_REMOTE_IMAGES', '2'],
    ['GRIMOIRE_IMPORT_REMOTE_MAX_IMAGES', '0'], ['GRIMOIRE_IMPORT_REMOTE_MAX_BYTES', '0'], ['GRIMOIRE_IMPORT_REMOTE_TIMEOUT_SECONDS', '0'], ['GRIMOIRE_IMPORT_REMOTE_TIMEOUT_SECONDS', '61'],
    ['GRIMOIRE_IMPORT_REMOTE_TOTAL_SECONDS', '9'], ['GRIMOIRE_IMPORT_REMOTE_TOTAL_SECONDS', '3601'], ['GRIMOIRE_IMPORT_CONCURRENCY', '0'], ['GRIMOIRE_IMPORT_CONVERTER_THREADS', '0'],
    ['GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS', '0'], ['GRIMOIRE_JOBS_STOP_GRACE_MS', '0'],
    ['GRIMOIRE_JOBS_PURGE_CRON', 'daily'], ['GRIMOIRE_JOBS_SWEEP_CRON', '* * * *'], ['GRIMOIRE_JOBS_UPLOAD_CLEANUP_CRON', '*/5 * * * * *'], ['GRIMOIRE_JOBS_REVISION_CRON', '; rm * * * *'],
    ['GRIMOIRE_SEARCH_STATEMENT_TIMEOUT_MS', '5'], ['GRIMOIRE_SEARCH_STATEMENT_TIMEOUT_MS', '30001'],
  ])('%s=%s', (name, value) => {
    expect(issuesOf({ [name]: value }).some((i) => i.includes(name))).toBe(true);
  });

  it('a remote image larger than an upload is refused, on the variable of the remote limit', () => {
    expect(issuesOf({ GRIMOIRE_FILES_MAX_BYTES: '1000', GRIMOIRE_IMPORT_REMOTE_MAX_BYTES: '1001' }).some((i) => i.includes('GRIMOIRE_IMPORT_REMOTE_MAX_BYTES'))).toBe(true);
    expect(issuesOf({ GRIMOIRE_FILES_MAX_BYTES: '1000', GRIMOIRE_IMPORT_REMOTE_MAX_BYTES: '1000' })).toEqual([]);
  });

  it('a malformed operand is reported by its own variable alone, and does not make the other one wrong', () => {
    const bad = issuesOf({ GRIMOIRE_FILES_MAX_BYTES: 'abc', GRIMOIRE_IMPORT_REMOTE_MAX_BYTES: '1000' });
    expect(bad.some((i) => i.includes('GRIMOIRE_FILES_MAX_BYTES'))).toBe(true);
    expect(bad.some((i) => i.includes('GRIMOIRE_IMPORT_REMOTE_MAX_BYTES'))).toBe(false);
    const other = issuesOf({ GRIMOIRE_IMPORT_REMOTE_MAX_BYTES: 'abc' }).filter((i) => i.includes('GRIMOIRE_IMPORT_REMOTE_MAX_BYTES'));
    expect(other).toHaveLength(1);
    expect(other[0]).not.toMatch(/larger than/);
  });

  it('with no remote limit set, a small upload limit lowers it instead of refusing the start', () => {
    expect(load({ GRIMOIRE_FILES_MAX_BYTES: '1000' }).import.remote.maxBytes).toBe(1000);
    expect(load().import.remote.maxBytes).toBe(20_971_520);
  });

  it('there is no variable for the size of a Markdown file: the seed cap is the limit', () => {
    expect(load({ GRIMOIRE_IMPORT_MAX_MARKDOWN_BYTES: '5' }).import).not.toHaveProperty('maxMarkdownBytes');
  });
});
