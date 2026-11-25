import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The e2e jobs run with the semantic search off, so their image is built without the ~400 MB of model files (a build that fetches them timed a job out at 20 minutes). The image job and the
// production image keep the models: `skip` is a build argument that has to be asked for, never the default.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file) => readFileSync(new URL(file, `file://${root}`), 'utf8');
const ci = read('.github/workflows/ci.yml');
const job = (name) => ci.match(new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [a-z0-9-]+:\\n|$)`))?.[0] ?? '';

test('the Dockerfile fetches the models unless the build says skip, and the skip leaves an empty directory', () => {
  const docker = read('Dockerfile');
  assert.match(docker, /^ARG GRIMOIRE_MODELS=fetch$/m);
  assert.match(docker, /RUN if \[ "\$GRIMOIRE_MODELS" = skip \]; then mkdir -p \/models; else node fetch-models\.mjs [^\n]*--verify[^\n]*; fi/);
});

test('every Compose service that builds the image passes the argument, defaulting to fetch', () => {
  for (const file of ['compose.yaml', 'compose.m3.yaml']) {
    const text = read(file);
    assert.equal(/^\s+build: \.$/m.test(text), false, `${file} builds with no argument`);
    const builds = text.match(/^ {4}build:\n {6}context: \.\n {6}args:\n {8}GRIMOIRE_MODELS: "\$\{GRIMOIRE_IMAGE_MODELS:-fetch\}"$/gm) ?? [];
    assert.equal(builds.length, (text.match(/^ {4}build:/gm) ?? []).length, file);
  }
});

test('the e2e jobs skip the models and turn the semantic search off, and the image job and the integration job do neither', () => {
  for (const name of ['e2e-m1', 'e2e-m2', 'e2e-m3', 'e2e-m4', 'e2e-m5', 'e2e-web', 'e2e-web-browsers']) {
    const text = job(name);
    assert.match(text, /\n {4}env:\n {6}GRIMOIRE_IMAGE_MODELS: skip\n {6}GRIMOIRE_SEMANTIC_SEARCH: 'off'\n/, name);
  }
  for (const name of ['image', 'integration']) assert.doesNotMatch(job(name), /GRIMOIRE_IMAGE_MODELS|GRIMOIRE_SEMANTIC_SEARCH/, name);
});
