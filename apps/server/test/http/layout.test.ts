import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { routers } from '../../src/routes/registry.js';

const src = path.resolve(import.meta.dirname, '../../src');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
const order = ['me', 'config', 'collections', 'collection-access', 'pages', 'pages-markdown', 'trash', 'revisions', 'users', 'groups', 'reset-state', 'attachments', 'search', 'imports'];

describe('router layout', () => {
  it('has the 14 router files and the registry, and the registry imports each in order', () => {
    const dir = path.join(src, 'routes');
    expect(readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()).toEqual([...order.map((n) => `${n}.ts`), 'registry.ts'].sort());
    const registry = readFileSync(path.join(dir, 'registry.ts'), 'utf8');
    const imported = [...registry.matchAll(/from '\.\/([\w-]+)\.js'/g)].map((m) => m[1]);
    expect(imported).toEqual(order);
    expect(routers).toHaveLength(14);
    expect(new Set(routers).size).toBe(14);
  });

  it('creates a router or an application only in the factory and the health routes', () => {
    const offenders = files(src)
      .filter((f) => /new (OpenAPIHono|Hono)\b/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(src, f).split(path.sep).join('/'))
      .filter((f) => f !== 'http/factory.ts' && !f.startsWith('health/'));
    expect(offenders).toEqual([]);
  });

  it('lets no route reach the reseed call: only the collaboration host files name it', () => {
    const offenders = files(src)
      .filter((f) => /\.reseed\(/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(src, f).split(path.sep).join('/'))
      .filter((f) => !f.startsWith('collab/'));
    expect(offenders).toEqual([]);
  });

  it('types the converter dependency as the existing converter port', () => {
    const env = readFileSync(path.join(src, 'http/env.ts'), 'utf8');
    expect(env).toMatch(/converter: MarkdownConverter\b/);
    expect(env).not.toMatch(/reseed/);
  });
});
