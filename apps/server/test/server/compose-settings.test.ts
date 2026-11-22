import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { requiredGracePeriodMs } from '../../src/lifecycle/budget.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const schemaDir = path.join(root, 'packages/adapters/config-env/src');

/** Settings the local Compose app deliberately does not pass, each with the reason. Everything else the loader knows must appear in compose.yaml. */
const NOT_PASSED: Readonly<Record<string, string>> = {
  GRIMOIRE_HOST: 'the image sets 0.0.0.0 (a container must listen on all its interfaces)',
  GRIMOIRE_PORT: 'fixed at 8080: the published port, the exposed port and the healthcheck use it',
  GRIMOIRE_COLLAB_PORT: 'collaboration shares the HTTP port in this stack; a second port would need its own published port',
};

it('every GRIMOIRE_* setting the loader reads appears in compose.yaml or is listed above with a reason', () => {
  const known = new Set(
    readdirSync(schemaDir).filter((f) => f.endsWith('.ts'))
      .flatMap((f) => readFileSync(path.join(schemaDir, f), 'utf8').match(/GRIMOIRE_[A-Z0-9]+(?:_[A-Z0-9]+)*/g) ?? [])
      .filter((n) => !n.endsWith('_') && n !== 'GRIMOIRE_S3'), // GRIMOIRE_S3 alone is a prefix named in a message
  );
  expect(known.size).toBeGreaterThan(30);
  const compose = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  const missing = [...known].filter((n) => !(n in NOT_PASSED) && !new RegExp(`^\\s+${n}:`, 'm').test(compose)).sort();
  expect(missing).toEqual([]);
  for (const n of Object.keys(NOT_PASSED)) expect(known.has(n), `${n} is listed as not passed but the loader does not read it`).toBe(true);
});

/** Settings the server refuses to start without in local mode, which is what the Compose app runs in. */
const REQUIRED = ['GRIMOIRE_DEV_TOKEN_SECRET', 'GRIMOIRE_DATABASE_URL', 'GRIMOIRE_ALLOWED_ORIGINS'];

it('every setting the server requires has a value in compose.yaml, or a generator the `up` target reaches', () => {
  const compose = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  const makefile = readFileSync(path.join(root, 'Makefile'), 'utf8');
  const envExample = readFileSync(path.join(root, '.env.example'), 'utf8');
  const prereqs = (target: string): string[] => (new RegExp(`^${target}:([^\\n]*)$`, 'm').exec(makefile)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  const reach = (target: string, seen = new Set<string>()): Set<string> => {
    for (const p of prereqs(target)) if (!seen.has(p)) { seen.add(p); reach(p, seen); }
    return seen;
  };
  const upReaches = reach('up');
  for (const name of REQUIRED) {
    const line = new RegExp(`^\\s+${name}:\\s*(.*)$`, 'm').exec(compose)?.[1]?.trim().replace(/^"|"$/g, '');
    expect(line, `${name} is not set in compose.yaml`).toBeDefined();
    // Every ${VAR}, ${VAR:-} and ${VAR:-default} anywhere in the value (a password inside a URL included) must have a value that Compose can read.
    const refs = [...(line ?? '').matchAll(/\$\{([A-Z0-9_]+)(:-([^}]*))?\}/g)].map((m) => ({ name: m[1] as string, hasDefault: m[2] !== undefined && (m[3] ?? '') !== '' }));
    const needs = refs.filter((r) => !r.hasDefault).map((r) => r.name);
    if ((line ?? '') !== '' && needs.length === 0) continue; // a fixed value, or only variables with a non-empty default
    for (const source of needs.length > 0 ? needs : [name]) {
    const inExample = new RegExp(`^${source}=.`, 'm').test(envExample);
    // A generator is a recipe (the tab-indented lines under the target's own line) that writes `NAME=`.
    const recipe = (target: string): string => new RegExp(`^${target.replace('.', '\\.')}:[^\\n]*\\n((?:\\t[^\\n]*\\n)*)`, 'm').exec(makefile)?.[1] ?? '';
    const generator = [...upReaches].find((t) => recipe(t).includes(`${source}=`));
    expect(inExample || generator !== undefined, `${source} (required by the server) has no value in compose.yaml or .env.example and no generator reachable from \`make up\``).toBe(true);
    }
  }
});

it('the app service gives the process at least its shutdown backstop plus the margin before Docker kills it (stop_grace_period)', () => {
  const compose = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  const grace = /^\s+stop_grace_period:\s*(\d+)s\s*$/m.exec(compose);
  expect(grace, 'compose.yaml must set stop_grace_period explicitly for the app service').not.toBeNull();
  const graceMs = Number(grace?.[1]) * 1000;
  // The committed file passes no save deadline of its own (the setting is empty unless the operator sets it), so the default of the loader applies.
  const schema = readFileSync(path.join(schemaDir, 'schema.ts'), 'utf8');
  const defaultSave = Number(/GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: field\(int\(1, MAX_INT\)\)\.default\((\d+)\)/.exec(schema)?.[1]);
  expect(defaultSave).toBeGreaterThan(0);
  expect(graceMs).toBeGreaterThanOrEqual(requiredGracePeriodMs(defaultSave));
});

