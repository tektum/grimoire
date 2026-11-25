import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// R6.4: production code answers access only through the collapsed form in packages/core/src/authorize/index.ts,
// so no caller can tell a missing page from a forbidden one. Any `.check(` / `.checkMany(` call outside the authoriser and tests fails.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const AUTHORIZER_DIR = path.join('packages', 'core', 'src', 'authorize');
/** Calls named `check` that are not the authoriser: Node's `net.BlockList.check(address, family)`. File and receiver must both match. */
const ALLOWED = [
  { file: 'packages/core/src/users/client-address.ts', receiver: 'list', reason: 'net.BlockList of trusted proxies' },
  { file: 'packages/adapters/config-env/src/schema.ts', receiver: 'LOOPBACK', reason: 'net.BlockList of loopback ranges' },
];

function sourceDirs(): string[] {
  const dirs: string[] = [];
  const add = (base: string): void => {
    for (const e of readdirSync(path.join(repoRoot, base), { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'adapters' && e.name !== 'node_modules') dirs.push(path.join(base, e.name, 'src'));
    }
  };
  add('apps'); add('packages'); add(path.join('packages', 'adapters'));
  return dirs;
}
function files(dir: string): string[] {
  try {
    return readdirSync(path.join(repoRoot, dir), { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts'))
      .map((e) => path.relative(repoRoot, path.join(e.parentPath, e.name)));
  } catch { return []; }
}

// Both scans parse only the texts that can hold what they look for (the word check or checkMany; a module path with authorize/ or one of the names of the decision)
// or that have a backslash: a text with no backslash has no escape sequence, so every name and path the parser reads is in it as written, and one with a backslash
// is left to the parser, which decodes. A whole word and not `.check`: a comment may stand between the dot and the name. Each file is parsed once for both scans.
// Parsing all of the production files twice took about 0.5 s idle and passed the 5 s default under a loaded test run.
const CHECK_NAME = /\bcheck(?:Many)?\b/;
const hasEscape = (text: string): boolean => text.includes('\\');

const parsed = new Map<string, { text: string; sf: ts.SourceFile }>();
/** The parse of `text` as `file`, made once and shared by the two scans (a different text under the same name, as the probes below pass, is parsed again). */
function parse(file: string, text: string): ts.SourceFile {
  const hit = parsed.get(file);
  if (hit !== undefined && hit.text === text) return hit.sf;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  parsed.set(file, { text, sf });
  return sf;
}

/** `<receiver>.check(...)` and `<receiver>.checkMany(...)` calls in `text`, with the receiver's source text. */
export function checkCalls(file: string, text: string): { file: string; line: number; receiver: string }[] {
  if (!hasEscape(text) && !CHECK_NAME.test(text)) return [];
  const sf = parse(file, text);
  const out: { file: string; line: number; receiver: string }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['check', 'checkMany'].includes(n.expression.name.text)) {
      out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, receiver: n.expression.expression.getText(sf) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The uncollapsed decision: importing `decide`, `decideCollection` or `createAuthorizer` (by name, by namespace, by re-export or dynamically) is how a
 * caller would get the denial reason without a `.check(` call. Only the authoriser module, the composition and one core test helper may.
 */
const UNCOLLAPSED_NAMES = ['decide', 'decideCollection', 'createAuthorizer'];
const UNCOLLAPSED_MODULE = /authorize\/(decide|authorizer)(\.js)?$/;
const IMPORT_ALLOWED = [
  'apps/server/src/composition.ts',
  'packages/core/src/testing/fake-access-store.ts', // the in-memory store decides collection visibility with the real decision
];

/** Imports of the uncollapsed decision in `text`: `file:line module`. */
export function uncollapsedImports(file: string, text: string): string[] {
  if (!hasEscape(text) && !text.includes('authorize/') && !UNCOLLAPSED_NAMES.some((name) => text.includes(name))) return [];
  const sf = parse(file, text);
  const out: string[] = [];
  const at = (n: ts.Node, what: string): void => { out.push(`${file}:${String(sf.getLineAndCharacterOfPosition(n.getStart()).line + 1)} ${what}`); };
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier)) {
      const module = n.moduleSpecifier.text;
      const bindings = ts.isImportDeclaration(n) ? n.importClause?.namedBindings : n.exportClause;
      const names = bindings !== undefined && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) ? bindings.elements.map((e) => (e.propertyName ?? e.name).text) : [];
      const wholeModule = ts.isImportDeclaration(n) ? bindings !== undefined && ts.isNamespaceImport(bindings) : bindings === undefined || ts.isNamespaceExport(bindings);
      if (names.some((x) => UNCOLLAPSED_NAMES.includes(x)) || (wholeModule && UNCOLLAPSED_MODULE.test(module))) at(n, module);
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg) && UNCOLLAPSED_MODULE.test(arg.text)) at(n, arg.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('only the collapsed authorisation answer is used outside the authoriser (R6.4)', () => {
  it('no production file outside packages/core/src/authorize calls .check( or .checkMany(', () => {
    const offenders = sourceDirs()
      .flatMap(files)
      .filter((f) => !f.startsWith(AUTHORIZER_DIR))
      .flatMap((f) => checkCalls(f, readFileSync(path.join(repoRoot, f), 'utf8')))
      .filter((c) => !ALLOWED.some((a) => a.file === c.file && a.receiver === c.receiver))
      .map((c) => `${c.file}:${String(c.line)} ${c.receiver}`);
    expect(offenders).toEqual([]);
  });

  it('the scan sees the collaboration host and the composition (it is not vacuous)', () => {
    const scanned = sourceDirs().flatMap(files);
    expect(scanned).toContain('packages/adapters/collab-hocuspocus/src/extensions/auth.ts');
    expect(scanned).toContain('apps/server/src/composition.ts');
    expect(readFileSync(path.join(repoRoot, 'packages/adapters/collab-hocuspocus/src/extensions/auth.ts'), 'utf8')).toContain('deps.access.pageAccess(');
  });

  it('the checker catches a direct call, a call through a property and checkMany, and lets the allow-listed BlockList through only in its file', () => {
    const probe = 'await authorizer.check(r); await deps.authz.checkMany(rs); list.check(a, "ipv4");';
    expect(checkCalls('apps/server/src/x.ts', probe).map((c) => c.receiver)).toEqual(['authorizer', 'deps.authz', 'list']);
    const kept = checkCalls('apps/server/src/x.ts', probe).filter((c) => !ALLOWED.some((a) => a.file === c.file && a.receiver === c.receiver));
    expect(kept).toHaveLength(3);
    // The forms a text filter could miss, one text each (the filter looks at a whole text): the name on the line after the dot, optional chaining, type arguments.
    for (const [probe, receiver] of [['await deps.authz.\n  check(r);', 'deps.authz'], ['await a?.check(r);', 'a'], ['await x.checkMany<Page>(rs);', 'x']] as const) {
      expect(checkCalls('apps/server/src/x.ts', probe).map((c) => c.receiver), probe).toEqual([receiver]);
    }
    expect(checkCalls('apps/server/src/x.ts', 'const checked = isChecked(x); // see check(')).toEqual([]);
    // What the parser sees and a plain text filter would not: a comment between the dot and the name, a name spelled with an escape, and code after an unfinished escape.
    for (const [probe, receiver] of [['await a./* note */check(r);', 'a'], ['await deps.authz.ch\\u0065ckMany(rs);', 'deps.authz'], ['await x.\\u{0000063}heck(r);', 'x'], ['// \\u{\nawait authorizer.check(r); // }', 'authorizer']] as const) {
      expect(checkCalls('apps/server/src/x.ts', probe).map((c) => c.receiver), probe).toEqual([receiver]);
    }
  });

  it('no production file outside the authoriser module and the composition imports decide, decideCollection or createAuthorizer', () => {
    const offenders = sourceDirs()
      .flatMap(files)
      .filter((f) => !f.startsWith(AUTHORIZER_DIR) && !IMPORT_ALLOWED.includes(f))
      .flatMap((f) => uncollapsedImports(f, readFileSync(path.join(repoRoot, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the import rule fails when an import is added: by name, renamed, namespace, re-export and dynamic; a type import of another name passes', () => {
    const bad = [
      "import { decide } from '@tektum/grimoire-core/authorize/decide';",
      "import { createAuthorizer as make } from '@tektum/grimoire-core/authorize/authorizer';",
      "import { decideCollection, other } from '../authorize/decide.js';",
      "import * as d from '../authorize/decide.js';",
      "export { decide } from '@tektum/grimoire-core/authorize/decide';",
      "export * from '../authorize/authorizer.js';",
      "const m = await import('../authorize/decide.js');",
    ];
    for (const line of bad) expect(uncollapsedImports('apps/server/src/x.ts', line), line).toHaveLength(1);
    // A named import is refused whatever module it comes from: a barrel that re-exports the decision must not open a way around the rule.
    for (const line of ["import { decide } from '@tektum/grimoire-core/authorize';", "import { createAuthorizer as make } from '../somewhere-else.js';"]) {
      expect(uncollapsedImports('apps/server/src/x.ts', line), line).toHaveLength(1);
    }
    // A name or a path spelled with escapes is decoded by the parser, so the filter must not skip it.
    for (const line of ["import { d\\u0065cide as pick } from '../elsewhere.js';", "import { \\u{0000064}ecide } from '../elsewhere.js';", "export * from '../auth\\x6frize/authorizer.js';"]) {
      expect(uncollapsedImports('apps/server/src/x.ts', line), line).toHaveLength(1);
    }
    expect(uncollapsedImports('apps/server/src/x.ts', "import type { DenyReason } from '../authorize/decide.js'; import { createPageAccess } from '@tektum/grimoire-core/authorize';")).toEqual([]);
  });
});
