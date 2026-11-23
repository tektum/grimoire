import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../http/factory.js';
import { routers } from '../routes/registry.js';
import { surface, surfaceDiff } from './surface.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

export function buildDocument(extra: readonly ReturnType<typeof createRouter>[] = []): object {
  const app = createRouter();
  for (const router of [...routers, ...extra]) app.route('/', router);
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer' });
  const document = app.getOpenAPIDocument({ openapi: '3.0.3', info: { title: 'Grimoire API', version: '1.0.0' } });
  for (const [route, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = (item as Record<string, Record<string, unknown> | undefined>)[method];
      if (operation === undefined) continue;
      if (typeof operation['operationId'] !== 'string') throw new Error(`${method.toUpperCase()} ${route} has no operationId`);
      if (operation['x-grimoire-policy'] === undefined) throw new Error(`${method.toUpperCase()} ${route} has no x-grimoire-policy`);
    }
  }
  return document;
}

/** Keys sorted at every level, so the file does not depend on registration order. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sorted(v)]));
}

export const render = (document: object): string => `${JSON.stringify(sorted(document), null, 2)}\n`;

const here = path.dirname(fileURLToPath(import.meta.url));
/** Generated at build, never committed: the document and the client types made from it. */
const DEFAULT_OUT = path.resolve(here, '../../../../packages/api-client/openapi.json');
/** The committed, reviewed summary of the document. */
export const SURFACE_FILE = path.resolve(here, '../../../../docs/api-surface.txt');

/** The command line: `emit.js [file]` writes the document; `--write-surface [file]` records the surface; `--check-surface [file]` fails when it differs from the build. Returns the exit code. */
export function run(args: readonly string[], print: (line: string) => void): number {
  const [mode, ...rest] = args[0]?.startsWith('--') === true ? args : ['--document', ...args];
  const file = rest[0];
  if (mode === '--write-surface') {
    writeFileSync(file ?? SURFACE_FILE, surface(buildDocument()));
    return 0;
  }
  if (mode === '--check-surface') {
    const recorded = readFileSync(file ?? SURFACE_FILE, 'utf8');
    const differences = surfaceDiff(recorded, surface(buildDocument()));
    if (differences.length === 0) return 0;
    for (const l of ['The API surface changed and docs/api-surface.txt does not show it. Run `bun run openapi:surface` and commit the file:', ...differences]) print(l);
    return 1;
  }
  const out = file ?? DEFAULT_OUT;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, render(buildDocument()));
  return 0;
}

/* v8 ignore start -- the entry point; apps/server/test/openapi/surface.test.ts runs it as a child process */
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2), (l) => { process.stderr.write(`${l}\n`); });
}
/* v8 ignore stop -- end of the entry point */
