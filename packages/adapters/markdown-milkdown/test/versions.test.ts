import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The converter relies on Milkdown internals that have no supported headless API: a new minor
 * version may change what it writes or break the headless context. This fails loudly instead of letting that pass.
 */
const PINNED = '7.23.0';

export function assertPinned(actual: string): void {
  if (actual !== PINNED) {
    throw new Error(
      `R3.8: @milkdown/core is ${actual}, the converter is verified against ${PINNED} only. Re-run the golden files, the ` +
        `parity tests and the headless context before changing the pin (UPDATE_GOLDEN=1 regenerates the golden files).`,
    );
  }
}

/** The first `node_modules/<name>/package.json` found walking up from here: the copy Node resolves for this package. */
function installedVersion(name: string): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const file = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
    if (dirname(dir) === dir) throw new Error(`${name} is not installed`);
  }
}

describe('Milkdown version pin', () => {
  it('@milkdown/core is 7.23.0', () => {
    expect(() => assertPinned(installedVersion('@milkdown/core'))).not.toThrow();
  });

  it('a different version fails with a message that names R3.8', () => {
    expect(() => assertPinned('7.24.0')).toThrow(/R3\.8/);
    expect(() => assertPinned('7.22.9')).toThrow(/7\.23\.0/);
  });

  it('y-prosemirror and yjs are the versions the contracts pin', () => {
    expect(installedVersion('y-prosemirror')).toBe('1.3.7');
    expect(installedVersion('yjs')).toBe('13.6.33');
  });
});
