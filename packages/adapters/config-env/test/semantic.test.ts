import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

// M7-T11 (contracts section 15.6): the settings of the semantic search. Every default and range; a refusal names its variable.
const key = () => randomBytes(12).toString('hex'); // generated per run: no secret-looking literal in the repository
const base = { GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: key() + key(), GRIMOIRE_DATABASE_URL: placeholderDatabaseUrl(), GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080' };
const load = (extra: Record<string, string> = {}) => loadConfig({ ...base, ...extra });
const issuesOf = (extra: Record<string, string>): string[] => {
  try { load(extra); } catch (e) { if (e instanceof ConfigError) return e.issues; throw e; }
  return [];
};

describe('Config.semantic', () => {
  it('has the defaults of the contracts', () => {
    expect(load().semantic).toEqual({
      enabled: true, model: 'multilingual-e5-base', modelDir: '/app/models', threads: 2, debounceSeconds: 30, sweepSeconds: 15, maxChunksPerMinute: 600,
      queryTimeoutMs: 1500, minSimilarity: 0, candidates: 100,
    });
  });

  it('is changed by the variables', () => {
    const c = load({
      GRIMOIRE_SEMANTIC_SEARCH: 'off', GRIMOIRE_SEMANTIC_MODEL: 'multilingual-e5-small', GRIMOIRE_SEMANTIC_MODEL_DIR: '/data/models', GRIMOIRE_SEMANTIC_THREADS: '4',
      GRIMOIRE_SEMANTIC_DEBOUNCE_SECONDS: '5', GRIMOIRE_SEMANTIC_SWEEP_SECONDS: '600', GRIMOIRE_SEMANTIC_MAX_CHUNKS_PER_MINUTE: '100000', GRIMOIRE_SEMANTIC_QUERY_TIMEOUT_MS: '10000',
      GRIMOIRE_SEMANTIC_MIN_SIMILARITY: '0.25', GRIMOIRE_SEMANTIC_CANDIDATES: '500',
    });
    expect(c.semantic).toEqual({
      enabled: false, model: 'multilingual-e5-small', modelDir: '/data/models', threads: 4, debounceSeconds: 5, sweepSeconds: 600, maxChunksPerMinute: 100_000,
      queryTimeoutMs: 10_000, minSimilarity: 0.25, candidates: 500,
    });
  });

  it('takes the ends of every range', () => {
    expect(load({ GRIMOIRE_SEMANTIC_MIN_SIMILARITY: '1', GRIMOIRE_SEMANTIC_THREADS: '1', GRIMOIRE_SEMANTIC_CANDIDATES: '10', GRIMOIRE_SEMANTIC_QUERY_TIMEOUT_MS: '100' }).semantic)
      .toMatchObject({ minSimilarity: 1, threads: 1, candidates: 10, queryTimeoutMs: 100 });
    expect(load({ GRIMOIRE_SEMANTIC_MIN_SIMILARITY: '0.0' }).semantic.minSimilarity).toBe(0);
  });

  it.each([
    ['GRIMOIRE_SEMANTIC_SEARCH', 'maybe'], ['GRIMOIRE_SEMANTIC_SEARCH', '1'], ['GRIMOIRE_SEMANTIC_MODEL', 'bge-m3'], ['GRIMOIRE_SEMANTIC_MODEL', 'base'],
    ['GRIMOIRE_SEMANTIC_MODEL_DIR', 'models'], ['GRIMOIRE_SEMANTIC_MODEL_DIR', '   '],
    ['GRIMOIRE_SEMANTIC_THREADS', '0'], ['GRIMOIRE_SEMANTIC_THREADS', '5'], ['GRIMOIRE_SEMANTIC_THREADS', '1.5'],
    ['GRIMOIRE_SEMANTIC_DEBOUNCE_SECONDS', '4'], ['GRIMOIRE_SEMANTIC_DEBOUNCE_SECONDS', '3601'],
    ['GRIMOIRE_SEMANTIC_SWEEP_SECONDS', '4'], ['GRIMOIRE_SEMANTIC_SWEEP_SECONDS', '601'],
    ['GRIMOIRE_SEMANTIC_MAX_CHUNKS_PER_MINUTE', '0'], ['GRIMOIRE_SEMANTIC_MAX_CHUNKS_PER_MINUTE', '100001'],
    ['GRIMOIRE_SEMANTIC_QUERY_TIMEOUT_MS', '99'], ['GRIMOIRE_SEMANTIC_QUERY_TIMEOUT_MS', '10001'],
    ['GRIMOIRE_SEMANTIC_MIN_SIMILARITY', '1.5'], ['GRIMOIRE_SEMANTIC_MIN_SIMILARITY', '-0.1'], ['GRIMOIRE_SEMANTIC_MIN_SIMILARITY', '1e-1'], ['GRIMOIRE_SEMANTIC_MIN_SIMILARITY', '0x1'], ['GRIMOIRE_SEMANTIC_MIN_SIMILARITY', 'high'],
    ['GRIMOIRE_SEMANTIC_CANDIDATES', '9'], ['GRIMOIRE_SEMANTIC_CANDIDATES', '501'],
  ])('%s=%s is refused, naming the variable', (name, value) => {
    const issues = issuesOf({ [name]: value });
    expect(issues.some((i) => i.includes(name)), issues.join('; ')).toBe(true);
    expect(issues.join('; ')).not.toContain(value === '   ' ? 'never' : `${value}"`); // a message gives the rule, not the value
  });
});
