import assert from 'node:assert/strict';
import { test } from 'node:test';
import integration from '../../../vitest.integration-coverage.config.js';
import merged from '../../../vitest.merged-coverage.config.js';
import unit from '../../../vitest.config.js';

// The merged run enforces both sets of floors: for a glob that both configs name, the higher floor of each metric holds.
const floors = (config) => Object.entries(config.test.coverage.thresholds).filter(([, value]) => typeof value === 'object');
const mergedFloors = Object.fromEntries(floors(merged));

test('every floor of the unit run and of the integration run is at least as strict in the merged run', () => {
  for (const config of [unit, integration]) {
    for (const [glob, floor] of floors(config)) {
      for (const [metric, value] of Object.entries(floor)) {
        assert.ok((mergedFloors[glob]?.[metric] ?? -1) >= value, `${glob} ${metric}: ${String(mergedFloors[glob]?.[metric])} < ${String(value)}`);
      }
    }
  }
});

test('a glob in both configs takes the higher floor of each metric, and the merged run never rewrites floors', () => {
  const glob = 'packages/adapters/collab-hocuspocus/src/**';
  const [a, b] = [unit, integration].map((config) => Object.fromEntries(floors(config))[glob]);
  assert.ok(a && b, 'the glob is in both configs');
  for (const metric of Object.keys(a)) assert.equal(mergedFloors[glob][metric], Math.max(a[metric], b[metric]));
  assert.equal(merged.test.coverage.thresholds.autoUpdate, false);
});
