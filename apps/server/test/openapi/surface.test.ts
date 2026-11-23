import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from '@hono/zod-openapi';
import { repoRoot, requireBuild, runToEnd } from '@tektum/grimoire-test-support';
import { createRouter, defineRoute } from '../../src/http/factory.js';
import { SURFACE_FILE, buildDocument, render, run } from '../../src/openapi/emit.js';
import { surface, surfaceDiff } from '../../src/openapi/surface.js';

const emit = path.join(repoRoot, 'apps/server/dist/openapi/emit.js');
let dir: string;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'surface-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/** A router with one route the committed surface does not know. */
function unrecorded() {
  const router = createRouter();
  const route = defineRoute({
    method: 'post', path: '/v1/unrecorded/{id}', operationId: 'unrecordedThing', tags: ['x'], policy: { kind: 'collection', param: 'id', need: 'write' },
    rateLimit: { max: 3, windowSeconds: 60 }, idempotent: true,
    request: { params: z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) }), body: { required: true, content: { 'application/json': { schema: z.object({ a: z.string() }).openapi('UnrecordedBody') } } } },
    responses: { 201: { description: 'made', content: { 'application/json': { schema: z.array(z.object({ b: z.string() }).openapi('UnrecordedItem')) } } } },
  });
  router.openapi(route, (c) => c.json([], 201));
  return router;
}

describe('the API surface file', () => {
  it('records exactly the operations the build has, so an API change is visible in review', () => {
    expect(readFileSync(SURFACE_FILE, 'utf8')).toBe(surface(buildDocument()));
  });

  it('shows a route that is not recorded as added lines with its policy, limits, body and response names, and the shape of each new schema', () => {
    const recorded = readFileSync(SURFACE_FILE, 'utf8');
    const diff = surfaceDiff(recorded, surface(buildDocument([unrecorded()])));
    expect(diff).toEqual([
      '+ POST /v1/unrecorded/{id} | op:unrecordedThing | policy:collection:write:id | path:id:string<uuid> | query:- | req:UnrecordedBody | res:201:UnrecordedItem[] | rate:3/60s | idem:yes',
      '+ schema UnrecordedBody = {a:string}',
      '+ schema UnrecordedItem = {b:string}',
    ]);
  });

  it('shows a route that was removed from the record as one added line, and a recorded route that is gone as one removed line', () => {
    const lines = readFileSync(SURFACE_FILE, 'utf8').split('\n');
    const dropped = lines.find((l) => l.startsWith('GET /v1/me')) as string;
    expect(dropped).toBeDefined();
    expect(surfaceDiff(lines.filter((l) => l !== dropped).join('\n'), surface(buildDocument()))).toEqual([`+ ${dropped}`]);
    expect(surfaceDiff(`${lines.join('\n')}GET /gone | op:gone`, surface(buildDocument()))).toEqual(['- GET /gone | op:gone']);
  });

  it('sorts by route then method, leaves the shared error statuses out and names inline schemas', () => {
    const body = (schema: object) => ({ content: { 'application/json': { schema } } });
    const text = surface({
      paths: {
        '/b': { post: { operationId: 'b', 'x-grimoire-policy': { kind: 'admin' }, responses: { '200': body({ type: 'object' }), '404': body({ $ref: '#/components/schemas/Error' }), '409': body({ $ref: '#/components/schemas/Error' }) } } },
        '/a': { get: { operationId: 'a', 'x-grimoire-policy': { kind: 'public' }, parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'integer', minimum: 1, maximum: 5, default: 2 } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': {} } } },
      },
    });
    expect(text.split('\n').slice(3)).toEqual([
      'GET /a | op:a | policy:public | path:id:string | query:cursor?:string,q:integer(1..5)=2 | req:- | res:204:- | rate:- | idem:no',
      'POST /b | op:b | policy:admin | path:- | query:- | req:- | res:200:{},409:Error | rate:- | idem:no',
      '',
    ]);
    expect(surface({})).toMatch(/^(#.*\n){3}$/);
  });

  it('writes shapes out, so a new required field, a changed bound or a changed enum shows as a changed line', () => {
    const doc = (extra: object, required: string[], max: number) => ({
      paths: { '/p': { post: { operationId: 'p', 'x-grimoire-policy': { kind: 'admin' }, requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Body' } } } }, responses: { '200': { content: { 'application/json': { schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' }, minItems: 1 } } } } } } } } } },
      components: { schemas: { Body: { type: 'object', required, properties: { role: { type: 'string', enum: ['a', 'b'] }, name: { type: 'string', minLength: 1, maxLength: max }, id: { type: 'string', format: 'uuid', nullable: true }, ...extra } } } },
    });
    const text = surface(doc({}, ['name'], 100));
    expect(text).toContain('schema Body = {id?:string<uuid>|null,name:string(1..100),role?:a|b}');
    expect(text).toContain('res:200:{n:integer,tags?:string[](1..)}');
    for (const changed of [doc({ extra: { type: 'boolean' } }, ['name'], 100), doc({}, ['name', 'role'], 100), doc({}, ['name'], 200)]) {
      expect(surfaceDiff(text, surface(changed)).length).toBeGreaterThan(0);
    }
    expect(surface({ components: { schemas: { M: { type: 'object', minProperties: 2, additionalProperties: { type: 'string' }, oneOf: undefined } } } })).toContain('schema M = {*:string}(min properties 2)');
    expect(surface({ components: { schemas: { U: { oneOf: [{ type: 'string' }, { $ref: '#/components/schemas/M' }], nullable: true }, A: { allOf: [{ $ref: '#/components/schemas/M' }] }, L: { type: 'array' } } } })).toMatch(/schema A = M\nschema L = any\[\]\nschema U = string\|M\|null\n/);
  });

  it('shows a changed parameter bound, a dropped strictness, a pattern, an exclusive bound and a nullable allOf', () => {
    const doc = (limitMax: number, strict: boolean) => ({
      paths: { '/l': { get: { operationId: 'l', 'x-grimoire-policy': { kind: 'admin' }, parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: limitMax } }] } } },
      components: { schemas: { Strict: { type: 'object', properties: { a: { type: 'string', pattern: '^x$' }, b: { type: 'number', exclusiveMinimum: 0 }, c: { type: 'number', exclusiveMaximum: 9 } }, ...(strict ? { additionalProperties: false } : {}) }, Page: { allOf: [{ $ref: '#/components/schemas/Strict' }], nullable: true } } },
    });
    const text = surface(doc(100, true));
    expect(text).toContain('query:limit?:integer(1..100)');
    expect(text).toContain('schema Strict = {a?:string/^x$/,b?:number>0,c?:number<9}!');
    expect(text).toContain('schema Page = Strict|null');
    expect(surfaceDiff(text, surface(doc(200, true)))).toHaveLength(2);
    expect(surfaceDiff(text, surface(doc(100, false)))).toHaveLength(2);
  });

  it('gives every operation an operationId and a policy, and the document is the same on every build', () => {
    const document = buildDocument() as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const operations = Object.values(document.paths).flatMap((item) => Object.values(item));
    expect(operations.length).toBeGreaterThan(0);
    for (const op of operations) {
      expect(typeof op['operationId']).toBe('string');
      expect(op['x-grimoire-policy']).toBeDefined();
    }
    expect(render(buildDocument())).toBe(render(buildDocument()));
  });
});

describe('the command line', () => {
  it('writes the document, records the surface, and checks it, failing with the lines that differ', () => {
    const out: string[] = [];
    const doc = path.join(dir, 'openapi.json');
    expect(run([doc], (l) => out.push(l))).toBe(0);
    expect(readFileSync(doc, 'utf8')).toBe(render(buildDocument()));
    const recorded = path.join(dir, 'surface.txt');
    expect(run(['--write-surface', recorded], (l) => out.push(l))).toBe(0);
    expect(run(['--check-surface', recorded], (l) => out.push(l))).toBe(0);
    expect(out).toEqual([]);
    const lines = readFileSync(recorded, 'utf8').split('\n');
    const dropped = lines.find((l) => l.startsWith('GET /v1/config')) as string;
    writeFileSync(recorded, lines.filter((l) => l !== dropped).join('\n'));
    expect(run(['--check-surface', recorded], (l) => out.push(l))).toBe(1);
    expect(out).toEqual([expect.stringContaining('bun run openapi:surface'), `+ ${dropped}`]);
  });

  // Starts a Node child that loads the built server modules: seconds on a loaded runner, so a 30 s bound.
  it('exits 1 from the built entry point on a surface that does not match, 0 on the committed one', { timeout: 30_000 }, async () => {
    requireBuild();
    const ok = await runToEnd([emit, '--check-surface'], {});
    expect([ok.code, ok.output]).toEqual([0, '']);
    const stale = path.join(dir, 'stale.txt');
    writeFileSync(stale, readFileSync(SURFACE_FILE, 'utf8').split('\n').filter((l) => !l.startsWith('GET /v1/me')).join('\n'));
    const bad = await runToEnd([emit, '--check-surface', stale], {});
    expect(bad.code).toBe(1);
    expect(bad.output).toContain('+ GET /v1/me');
  });
});
