// Test-only server entry: the real `run` with extra shutdown hooks added to the composition, chosen by T07_HOOKS (read here, never by src).
// Production has no hook registry and no flag: hooks come from composition.ts only; a test adds its own by wrapping `compose`.
import { compose } from '../../../dist/composition.js';
import { run } from '../../../dist/lifecycle/run.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const specs = (process.env.T07_HOOKS ?? '').split(',').filter(Boolean);
const extra = [];
for (const spec of specs) {
  // Fixture, not a wait: the hook under test is deliberately slow (2.5 s) so the test can observe the process living until it ends.
  if (spec === 'slow') extra.push({ name: 'test-slow', phase: 'save-pages', deadlineMs: 20_000, run: () => sleep(2500) });
  if (spec === 'hang-500') extra.push({ name: 'test-hang', phase: 'stop-timers', deadlineMs: 500, run: () => new Promise(() => undefined) });
  if (spec === 'hang-forever') extra.push({ name: 'test-hang', phase: 'stop-timers', deadlineMs: 600_000, run: () => new Promise(() => undefined) });
}

await run({
  compose: () => {
    const composed = compose();
    return composed.ok ? { ...composed, ctx: { ...composed.ctx, shutdownHooks: [...composed.ctx.shutdownHooks, ...extra] } } : composed;
  },
});
