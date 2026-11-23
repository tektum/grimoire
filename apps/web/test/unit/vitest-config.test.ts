// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');
const text = readFileSync(path.join(root, 'vitest.config.js'), 'utf8');
/** The configuration as data, read by a separate process (a test of the client does not import the repository's own tooling files). */
const config: unknown = JSON.parse(
  execFileSync(process.execPath, ['--input-type=module', '-e', "import config from './vitest.config.js'; process.stdout.write(JSON.stringify(config));"], { cwd: root, encoding: 'utf8' }),
);
type Project = { test: { name: string; environment?: string; include: string[]; exclude: string[] } };
const projects = (config as unknown as { test: { projects: Project[] } }).test.projects;
const scripts = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
const coverage = (config as unknown as { test: { coverage: { include: string[]; exclude: string[]; thresholds: Record<string, unknown> } } }).test.coverage;

describe('vitest.config.js for the web client', () => {
  it('has a web project in a browser-like environment for the tests of apps/web, and the unit project leaves apps/web alone', () => {
    const web = projects.find((p) => p.test.name === 'web');
    const unit = projects.find((p) => p.test.name === 'unit');
    expect(web?.test.environment).toBe('happy-dom');
    expect(web?.test.include).toEqual(['apps/web/{src,test}/**/*.test.{ts,tsx}']);
    expect(web?.test.exclude).toContain('apps/web/test-e2e/**');
    for (const pattern of ['**/*.int.test.ts', '**/*.container.test.ts']) expect([pattern, web?.test.exclude.some((e) => e.includes(pattern.slice(3)))]).toEqual([pattern, true]);
    expect(unit?.test.exclude).toContain('apps/web/**');
  });

  it('runs the web project in the test, coverage and CI coverage scripts, once each', () => {
    for (const name of ['test', 'test:coverage', 'test:coverage:ci']) {
      expect([name, (scripts[name] ?? '').match(/--project web/g)?.length]).toEqual([name, 1]);
      expect([name, (scripts[name] ?? '').includes('--project unit')]).toEqual([name, true]);
    }
  });

  it('has the CI unit job run the coverage script that includes the web project', () => {
    const ci = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    const unit = ci.slice(ci.indexOf('\n  unit:'), ci.indexOf('\n  licence:'));
    expect(unit).toContain('run: bun run test:coverage:ci');
  });

  it('counts the .tsx files of the web client in the coverage, and leaves its tests out', () => {
    expect(coverage.include).toEqual(['{apps,packages}/**/src/**/*.{ts,tsx}']);
    expect(coverage.exclude).toEqual(expect.arrayContaining(['**/*.test.ts', '**/*.test.tsx']));
  });

  it('has a coverage floor for apps/web/src, and every exclusion of the list carries its reason on the same line', () => {
    expect(coverage.thresholds['apps/web/src/**']).toBeDefined();
    const start = text.indexOf('exclude: [', text.indexOf('coverage:'));
    const entries = text
      .slice(start, text.indexOf('],', start))
      .split('\n')
      .filter((l) => /"[^"]+"/.test(l) && !l.includes('...'));
    for (const line of entries) expect([line.trim(), /\/\/\s*\S/.test(line)]).toEqual([line.trim(), true]);
  });
});
