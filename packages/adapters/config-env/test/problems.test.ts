import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

const local = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef',
  GRIMOIRE_DATABASE_URL: placeholderDatabaseUrl(),
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
};

function problemsOf(env: Record<string, string>): ConfigError['problems'] {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  return [];
}

describe('configuration errors carry the setting name and the rule, never the value', () => {
  it.each([
    ['GRIMOIRE_COLLAB_PREAUTH_TIMEOUT_SECONDS', '0'],
    ['GRIMOIRE_DESCOPE_MAX_TOKEN_LIFETIME_SECONDS', '-1'],
  ])('%s=%s reports a rule', (name, value) => {
    const problems = problemsOf({ ...local, [name]: value });
    const p = problems.find((x) => x.setting === name);
    expect(p).toBeDefined();
    expect(p?.rule).toMatch(/integer/);
    expect(p?.rule).not.toContain(value === '0' ? '=0' : '-1');
  });

  it('no value of any setting appears in any problem, whatever the setting holds', () => {
    const src = readFileSync(new URL('../src/schema.ts', import.meta.url), 'utf8');
    const names = [...new Set(src.match(/GRIMOIRE_[A-Z0-9_]+/g) ?? [])];
    expect(names.length).toBeGreaterThan(20);
    const mark = 'ZZvalueMarkZZ-9f3a';
    for (const name of names) {
      for (const value of [mark, `-${mark}`, `http://${mark}:${mark}@h/${mark}`]) {
        for (const p of problemsOf({ ...local, [name]: value })) {
          expect(`${p.setting} ${p.rule}`, name).not.toContain(mark);
        }
      }
    }
  });
});
