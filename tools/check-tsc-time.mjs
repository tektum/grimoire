// Builds the server project from clean and fails when it takes more than the bound.
import { spawnSync } from 'node:child_process';

const boundSeconds = 60;
const started = performance.now();
const result = spawnSync('bunx', ['tsc', '-b', 'apps/server', '--force'], { stdio: 'inherit' });
const seconds = (performance.now() - started) / 1000;

console.log(`tsc-seconds: ${seconds.toFixed(2)}`);
if (result.status !== 0) {
  console.error('tsc failed');
  process.exit(1);
}
if (seconds > boundSeconds) {
  console.error(`tsc took more than ${boundSeconds} s`);
  process.exit(1);
}
