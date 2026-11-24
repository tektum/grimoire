// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, '../../scripts/render-headers.mjs');
const dir = mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'grimoire-headers-json-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.each(['login-document', 'app-wide'])('headers.json, --signin=%s', (mode) => {
  it('has exactly the keys /index.html and /login.html, each a list of `Name: value` lines that includes a content security policy', () => {
    execFileSync(process.execPath, [script, '--api-origin', 'https://api.example.test', '--collab-origin', 'wss://api.example.test', '--store-origin', 'https://files.example.test', '--signin', mode, '--out', dir]);
    const json = JSON.parse(readFileSync(path.join(dir, 'headers.json'), 'utf8')) as Record<string, string[]>;
    expect(Object.keys(json).sort()).toEqual(['/index.html', '/login.html']);
    for (const lines of Object.values(json)) {
      expect(lines.length).toBeGreaterThan(3);
      expect(lines.every((l) => /^[A-Za-z-]+: \S/.test(l))).toBe(true);
      expect(lines.filter((l) => l.startsWith('Content-Security-Policy: '))).toHaveLength(1);
    }
  });
});
