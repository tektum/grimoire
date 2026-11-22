import { createRun } from '../../../dist/lifecycle/run.js';
import { startCollab } from '../../../dist/collab/index.js';

// Test-only process seam: SIGTERM arrives after the real collab host started but before its hooks returned.
await createRun({ exit: (code) => { process.exit(code); } }, async (deps) => {
  process.kill(process.pid, 'SIGTERM');
  return startCollab(deps);
})();
