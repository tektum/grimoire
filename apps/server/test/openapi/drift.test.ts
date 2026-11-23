import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot, requireBuild, runToEnd } from '@tektum/grimoire-test-support';

const emit = path.join(repoRoot, 'apps/server/dist/openapi/emit.js');
const committed = path.join(repoRoot, 'packages/api-client/openapi.json');
let dir: string;

beforeAll(() => {
  requireBuild();
  dir = mkdtempSync(path.join(tmpdir(), 'openapi-drift-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function emitTo(file: string): Promise<void> {
  const result = await runToEnd([emit, file], {});
  expect(result.output).toBe('');
  expect(result.code).toBe(0);
}

// Each case starts a Node child that loads the built server modules: seconds on a loaded runner, so a 30 s bound.
describe('the emitted OpenAPI document', () => {
  it('equals the committed file, so the generated files are never hand-edited', { timeout: 30_000 }, async () => {
    const file = path.join(dir, 'clean.json');
    await emitTo(file);
    expect(readFileSync(file, 'utf8')).toBe(readFileSync(committed, 'utf8'));
  });

  it('is byte-identical on a second run', { timeout: 30_000 }, async () => {
    const [a, b] = [path.join(dir, 'a.json'), path.join(dir, 'b.json')];
    await emitTo(a);
    await emitTo(b);
    expect(readFileSync(a, 'utf8')).toBe(readFileSync(b, 'utf8'));
  });

  it('shows a hand edit of a response schema as a difference that the command removes', { timeout: 30_000 }, async () => {
    const file = path.join(dir, 'edited.json');
    const document = JSON.parse(readFileSync(committed, 'utf8')) as { components: { schemas: { ClientConfig: { properties: Record<string, unknown> } } } };
    delete document.components.schemas.ClientConfig.properties['local'];
    writeFileSync(file, JSON.stringify(document, null, 2));
    expect(readFileSync(file, 'utf8')).not.toBe(readFileSync(committed, 'utf8'));
    await emitTo(file);
    expect(readFileSync(file, 'utf8')).toBe(readFileSync(committed, 'utf8'));
  });

  it('gives every operation an operationId and a policy', () => {
    const document = JSON.parse(readFileSync(committed, 'utf8')) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const operations = Object.values(document.paths).flatMap((item) => Object.values(item));
    expect(operations.length).toBeGreaterThan(0);
    for (const op of operations) {
      expect(typeof op['operationId']).toBe('string');
      expect(op['x-grimoire-policy']).toBeDefined();
    }
  });
});
