import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// M7-T07: `make test-m7-real` is the target of the owner's real Notion export (M7-T08). The export is private: gitignored, never in CI. Without it the target says so and succeeds.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const make = (env: Record<string, string>) => spawnSync('make', ['-s', 'test-m7-real'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });

describe('make test-m7-real', () => {
  it('prints "blocked: no export provided" and exits 0 when there is no export', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'm7-real-'));
    try {
      const r = make({ M7_REAL_EXPORT: path.join(dir, 'export.zip') }); // a path with nothing at it, whatever is in test-data on this machine
      expect(r.stdout.trim()).toBe('blocked: no export provided');
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not pass for an export it has no checks for: it says so and fails (the checks are M7-T08)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'm7-real-'));
    try {
      const file = path.join(dir, 'export.zip');
      writeFileSync(file, 'x');
      const r = make({ M7_REAL_EXPORT: file });
      expect(r.status, 'make fails when the recipe does').not.toBe(0);
      expect(r.stdout + r.stderr).toContain('export found');
      expect(r.stdout + r.stderr).toContain('M7-T08');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the real export out of git', () => {
    const ignored = spawnSync('git', ['check-ignore', '-q', 'test-data/notion-real/export.zip'], { cwd: root });
    expect(ignored.status, 'test-data/notion-real/export.zip is ignored').toBe(0);
  });
});
