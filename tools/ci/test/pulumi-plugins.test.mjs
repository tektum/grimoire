import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const plugins = read('infra/pulumi-plugins.txt')
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.startsWith('#'))
  .map((line) => {
    const [name, version, server, sha256] = line.split(/\s+/);
    return { name, version, server, sha256 };
  });

test('every plugin line has a name, a semantic version, a GitHub release server and a sha256', () => {
  assert.ok(plugins.length >= 3);
  for (const p of plugins) {
    assert.match(p.version, /^\d+\.\d+\.\d+$/, p.name);
    assert.match(p.server, /^github:\/\/api\.github\.com\/[a-z]+$/, p.name);
    assert.match(p.sha256, /^[0-9a-f]{64}$/, p.name);
  }
  assert.equal(new Set(plugins.map((p) => p.name)).size, plugins.length, 'one line for each plugin');
});

test('the providers that sst.config.ts names are pinned at the same versions', () => {
  const config = read('sst.config.ts');
  for (const name of ['aws', 'random', 'descope']) {
    const declared = new RegExp(`${name}: \\{[^}]*version: '(\\d+\\.\\d+\\.\\d+)'`).exec(config)?.[1];
    assert.ok(declared, `${name} is declared with a version in sst.config.ts`);
    assert.equal(plugins.find((p) => p.name === name)?.version, declared, name);
  }
});

test('the workflow installs the listed plugins with their checksums and then forbids any other download', () => {
  const workflow = read('.github/workflows/descope-infra.yml');
  assert.match(workflow, /plugin install resource "\$name" "\$version" --server "\$server" --checksum "\$sha256" --reinstall/);
  assert.match(workflow, /done < infra\/pulumi-plugins\.txt/);
  assert.match(workflow, /PULUMI_DISABLE_AUTOMATIC_PLUGIN_ACQUISITION: "true"/);
  assert.ok(workflow.indexOf('done < infra/pulumi-plugins.txt') < workflow.indexOf('PULUMI_DISABLE_AUTOMATIC_PLUGIN_ACQUISITION'), 'installed before the run that forbids downloads');
});
