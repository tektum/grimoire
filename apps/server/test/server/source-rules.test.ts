import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '../../src');
const repoRoot = path.resolve(here, '../../../..');

function files(dir: string, exts: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && exts.some((x) => e.name.endsWith(x)))
    .map((e) => path.join(e.parentPath, e.name));
}
const sources = files(srcDir, ['.ts']);
const rel = (f: string) => path.relative(srcDir, f);

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/** Calls shaped like `<expr>.info(...)` and friends, with the file and whether the event name is a string literal. */
function loggerCalls(file: string): { file: string; line: number; literal: string | undefined }[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: { file: string; line: number; literal: string | undefined }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && LEVELS.has(n.expression.name.text)) {
      const first = n.arguments[0];
      const literal = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : undefined;
      out.push({ file: rel(file), line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, literal });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('source rules for apps/server/src', () => {
  it('every logger call uses a string-literal event name (events.ts holds the one typed wrapper)', () => {
    const offenders = sources
      .filter((f) => rel(f) !== 'events.ts')
      .flatMap(loggerCalls)
      .filter((c) => c.literal === undefined)
      .map((c) => `${c.file}:${c.line}`);
    expect(offenders).toEqual([]);
  });

  it('the checker itself catches a non-literal event name', () => {
    const probe = path.join(srcDir, '__probe.ts');
    const sf = ts.createSourceFile(probe, 'log.info(`x${1}`); log.warn(name); log.error("ok.name", {});', ts.ScriptTarget.Latest, true);
    const found: (string | undefined)[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && LEVELS.has(n.expression.name.text)) {
        const a = n.arguments[0];
        found.push(a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : undefined);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(found).toEqual([undefined, undefined, 'ok.name']);
  });

  it('every literal event name used by server code is declared in events.ts', async () => {
    const events = readFileSync(path.join(srcDir, 'events.ts'), 'utf8');
    const used = sources.filter((f) => rel(f) !== 'cli.ts').flatMap(loggerCalls).map((c) => c.literal).filter((l): l is string => l !== undefined);
    for (const name of new Set(used)) expect(events, name).toContain(`'${name}'`);
    expect(used.length).toBeGreaterThan(10);
  });

  it('reads no process.env', () => {
    const offenders = sources.filter((f) => /process\s*\.\s*env|process\s*\[\s*['"]env['"]\s*\]|from\s+['"](node:)?process['"]/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('imports adapter packages as values only in composition.ts and cli.ts', () => {
    const offenders = sources.filter((f) => !['composition.ts', 'cli.ts'].includes(rel(f))).filter((f) =>
      readFileSync(f, 'utf8').split('\n').some((l) => /from ['"]@tektum\/grimoire-adapter/.test(l) && !/^\s*import type/.test(l)),
    ).map(rel);
    expect(offenders).toEqual([]);
  });

  it('cli.ts migrates only through composition and contains no adapter imports', () => {
    const cli = readFileSync(path.join(srcDir, 'cli.ts'), 'utf8');
    expect(cli).toContain('composeMigrate');
    expect(cli).not.toContain("from '@tektum/grimoire-adapter");
    expect(sources.filter((f) => readFileSync(f, 'utf8').includes('runMigrations')).map(rel)).toEqual(['composition.ts']); // the old rule, moved with S1: one place runs migrations
    expect(sources.filter((f) => rel(f) !== 'composition.ts' && /from '@tektum\/grimoire-adapter/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('no package.json declares http-terminator or terminus', () => {
    const manifests = [...files(path.join(repoRoot, 'apps'), ['package.json']), ...files(path.join(repoRoot, 'packages'), ['package.json'])]
      .filter((f) => !f.includes('node_modules'));
    const hits = manifests.filter((f) => /http-terminator|terminus/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
