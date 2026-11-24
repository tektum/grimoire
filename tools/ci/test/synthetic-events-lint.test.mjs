import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

/** Lints `source` as if it were the file `name`: the exit code and the messages. */
function lint(name, source) {
  const run = spawnSync('bunx', ['eslint', '--stdin', '--stdin-filename', name, '--format', 'json'], { cwd: root, input: source, encoding: 'utf8' });
  const messages = JSON.parse(run.stdout)[0]?.messages ?? [];
  return { status: run.status, rules: messages.map((m) => m.ruleId), text: messages.map((m) => m.message).join('\n') };
}

const MAKES_A_PASTE = "export const x = () => { document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true })); };\n";

test('a specification that builds a paste event, a drag event or a paste by a plain Event is refused, with the way to do it', () => {
  for (const source of [MAKES_A_PASTE, "export const y = () => new DragEvent('drop', {});\n", "export const z = () => new Event('paste');\n"]) {
    const result = lint('apps/web/test-e2e/safety/new.spec.ts', source);
    assert.equal(result.status, 1, source);
    assert.ok(result.rules.includes('no-restricted-syntax'));
    assert.match(result.text, /pasteIntoEditor/);
  }
});

test('the helper itself may build them, and another event is not refused', () => {
  assert.equal(lint('apps/web/test-e2e/support/paste.ts', MAKES_A_PASTE).status, 0);
  assert.equal(lint('apps/web/test-e2e/safety/new.spec.ts', "export const k = () => new KeyboardEvent('keydown');\nexport const e = () => new Event('input');\n").status, 0);
});

test('the other rules of the block of the web tests still apply there (a computed dynamic import is refused)', () => {
  const result = lint('apps/web/test-e2e/safety/new.spec.ts', 'export const m = async (name: string) => import(name);\n');
  assert.equal(result.status, 1);
  assert.match(result.text, /plain string literal/);
});

test('the dynamic-import bans of apps/web still apply to the web tests (a server-only library, an adapter, apps/server)', () => {
  for (const source of ["export const a = () => import('hono');\n", "export const b = () => import('@tektum/grimoire-adapter-pg');\n", "export const c = () => require('kysely');\n", "export const d = () => import(`pino`);\n"]) {
    const result = lint('apps/web/test-e2e/safety/new.spec.ts', source);
    assert.equal(result.status, 1, source);
    assert.ok(result.rules.includes('no-restricted-syntax'), source);
  }
  // the same, as a file the block does not cover, for the rule to be the one that fires:
  assert.equal(lint('apps/web/test-e2e/safety/new.spec.ts', "export const e = () => import('./local');\n").status, 0);
});
