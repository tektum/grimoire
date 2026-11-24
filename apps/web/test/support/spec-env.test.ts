// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../test-e2e');
const specs = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? specs(full) : name.endsWith('.spec.ts') ? [full] : [];
  });

/**
 * Playwright loads every spec file before it runs any, so a line at the top of one file that assigns to `process.env` is in force for all of them: the stand-in specs
 * once gave `E2E_DEV_TOKEN_SECRET` a made-up value that way, and every real-stack spec signed with it and was refused (401). A spec sets the environment inside a test,
 * and puts it back.
 */
describe('spec files and the process environment', () => {
  it('finds the spec files it is meant to guard', () => {
    expect(specs(root).length).toBeGreaterThan(30);
  });

  it('no spec file assigns to process.env at the top level of the module', () => {
    const offenders: string[] = [];
    for (const file of specs(root)) {
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        // A line that starts in column 0 is at the top level of the module (the formatter indents everything inside a function or a block).
        if (/^(?:process\.env\b[^\n]*?(?:\?\?=|\|\|=|&&=|(?<![=!<>])=(?!=))|Object\.assign\(\s*process\.env\b)/.test(line)) offenders.push(`${path.relative(root, file)}:${String(i + 1)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the pattern catches the forms that matter (a self-test of the guard)', () => {
    const pattern = /^(?:process\.env\b[^\n]*?(?:\?\?=|\|\|=|&&=|(?<![=!<>])=(?!=))|Object\.assign\(\s*process\.env\b)/;
    for (const bad of ["process.env['A'] ??= 'x';", "process.env.A = 'x';", "process.env['A'] ||= 'x';", 'Object.assign(process.env, { A: 1 });']) expect(pattern.test(bad)).toBe(true);
    for (const fine of ["  process.env['A'] = 'x';", "const a = process.env['A'];", "if (process.env['A'] === 'x') {}", '// process.env[A] = 1']) expect(pattern.test(fine)).toBe(false);
  });
});
