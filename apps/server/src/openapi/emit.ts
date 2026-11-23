import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../http/factory.js';
import { routers } from '../routes/registry.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

export function buildDocument(): object {
  const app = createRouter();
  for (const router of routers) app.route('/', router);
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

/** Where the document goes: the committed file, or the path given as the first argument (the drift test uses a temporary one). */
const DEFAULT_OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/api-client/openapi.json');

/* v8 ignore start -- the entry point; apps/server/test/openapi/drift.test.ts runs it as a child process */
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? DEFAULT_OUT;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, render(buildDocument()));
}
/* v8 ignore stop -- end of the entry point */
