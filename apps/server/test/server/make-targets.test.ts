import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const makefile = readFileSync(path.join(root, 'Makefile'), 'utf8');
const defined = new Set([...makefile.matchAll(/^([a-z0-9][a-z0-9-]*):/gm)].map((m) => m[1] as string));
const phony = new Set(makefile.split('\n').filter((l) => l.startsWith('.PHONY:')).flatMap((l) => l.slice('.PHONY:'.length).trim().split(/\s+/)));

/** R13.1: the commands a developer is told to run exist, and are not shadowed by a file of the same name. */
describe('the Makefile', () => {
  const lifecycle = ['up', 'migrate', 'test', 'down', 'reset', 'down-volumes', 'check-compose'];
  const scenarios = ['test-m1', 'test-m1-office', 'test-m1-mutation', 'test-m2', 'test-m2-hostile-mutation', 'test-m3'];

  it.each([...lifecycle, ...scenarios])('has the target %s, declared phony', (target) => {
    expect(defined.has(target), `${target} is not defined`).toBe(true);
    expect(phony.has(target), `${target} is not in .PHONY`).toBe(true);
  });

  it('runs the settings test and validates both Compose file sets in check-compose', () => {
    const body = makefile.slice(makefile.indexOf('\ncheck-compose:'), makefile.indexOf('\nmigrate:'));
    const recipe = body.split('\n').map((l) => l.trim());
    expect(recipe.some((l) => l.includes('compose-settings.test.ts'))).toBe(true);
    // Whole lines: the line of the second set also contains `config --quiet`, so a substring would pass with the first one gone.
    expect(recipe).toContain('$(COMPOSE) config --quiet');
    expect(recipe).toContain('$(COMPOSE) -f compose.yaml -f compose.m3.yaml config --quiet');
  });
});
