// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, '../../scripts/render-headers.mjs');
const dir = mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'grimoire-headers-json-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The block of each path in a `headers` file: its indented lines, without the indent. */
function blocks(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let current = '';
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) { current = line; out[current] = []; } else out[current]?.push(line.trim());
  }
  return out;
}

describe.each(['login-document', 'app-wide'])('headers.json, --signin=%s', (mode) => {
  it('has exactly the keys /index.html and /login.html, each equal to the lines of its block of the headers file', () => {
    execFileSync(process.execPath, [script, '--api-origin', 'https://api.example.test', '--collab-origin', 'wss://api.example.test', '--store-origin', 'https://files.example.test', '--signin', mode, '--out', dir]);
    const json = JSON.parse(readFileSync(path.join(dir, 'headers.json'), 'utf8')) as Record<string, string[]>;
    expect(Object.keys(json).sort()).toEqual(['/index.html', '/login.html']);
    expect(json).toEqual(blocks(readFileSync(path.join(dir, 'headers'), 'utf8')));
  });
});
