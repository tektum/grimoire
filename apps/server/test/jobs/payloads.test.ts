import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Job payloads sit in tables the runtime role can read: ids only (decision 4 of the M7 plan: the tenant id and a UUID, nothing else).
const ALLOWED = new Set(['tenantId', 'importId', 'pageId']);
const src = path.resolve(import.meta.dirname, '../../src');

/** The `enqueue` calls of a source text whose payload is not absent and not an object literal with only allowed fields: "line: text" for each. */
export function badEnqueues(text: string): string[] {
  const file = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
  const bad: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'enqueue') {
      const payload = node.arguments[1];
      const fine = payload === undefined
        || (payload.kind === ts.SyntaxKind.UndefinedKeyword)
        || (ts.isIdentifier(payload) && payload.text === 'undefined')
        || (ts.isObjectLiteralExpression(payload) && payload.properties.every((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && ALLOWED.has(p.name.text)));
      if (!fine) bad.push(`${String(file.getLineAndCharacterOfPosition(node.getStart()).line + 1)}: ${node.getText().slice(0, 80)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return bad;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

describe('job payloads', () => {
  it('every enqueue in apps/server/src passes no payload or one with only a tenant id and an import or page id', () => {
    const found = sources(src).flatMap((file) => badEnqueues(readFileSync(file, 'utf8')).map((b) => `${path.relative(src, file)}:${b}`));
    expect(found).toEqual([]);
  });

  it('the check itself refuses a key, a URL, a file name and a spread, and accepts the allowed shapes', () => {
    expect(badEnqueues(`q.enqueue('a'); q.enqueue('a', undefined); q.enqueue('a', { tenantId, importId: id }); q.enqueue('a', { importId: 'x' }, { singletonKey: 'k' });`)).toEqual([]);
    expect(badEnqueues(`q.enqueue('a', { tenantId, key: 'tenants/t/imports/i/source.zip' });`)).toHaveLength(1);
    expect(badEnqueues(`q.enqueue('a', { ...row });`)).toHaveLength(1);
    expect(badEnqueues(`q.enqueue('a', payload);`)).toHaveLength(1);
    expect(badEnqueues(`q.enqueue('a', { importId: 'x', fileName: 'a.zip' });`)).toHaveLength(1);
  });
});
