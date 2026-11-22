import { createRun } from '../../../dist/lifecycle/run.js';

// Test-only startup lane: start the real host (including persistence), then fail its attachment.
await createRun({ exit: (code) => { process.exit(code); } }, async (deps) => {
  await deps.host.start(deps.hostDeps);
  throw new TypeError('deliberate collaboration start failure');
})();
