// TEST-ONLY entry (`@tektum/grimoire-adapter-collab-hocuspocus/testing`): lets a test drive the real save path (gate, saver, log) on the real converter.
// Production code must never import it: `createSaver` takes the test-only `breaker.disabled` option. Enforced by
// packages/core/test/boundaries/testing-subpath.test.ts.
export { createConversionGate, createSaver } from './save.js';
export { createCollabLog } from './events.js';
