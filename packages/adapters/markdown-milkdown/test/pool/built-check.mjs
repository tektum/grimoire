// Plain `node`, no test runner and no TypeScript loader: the built adapter converts through its built worker, and a
// closed pool leaves nothing alive, so this process ends by itself (it never calls process.exit).
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createMarkdownConverter } from '../../dist/index.js';

const fixture = fileURLToPath(new URL('./fixtures/behaviours.mjs', import.meta.url));

const real = createMarkdownConverter();
const seeded = await real.seed('# Built\n\nworker from dist\n');
assert.equal(seeded.ok, true);
assert.deepEqual(await real.toMarkdown(seeded.state), { ok: true, markdown: '# Built\n\nworker from dist\n', text: 'Built\nworker from dist' });
await real.close();
assert.equal(real.stats().threads, 0);

const stuck = createMarkdownConverter({ workerPath: fixture, closeDeadlineMs: 100, timeoutMs: 20_000 });
const running = stuck.seed('spin');
await new Promise((resolve) => setTimeout(resolve, 100));
await stuck.close();
assert.deepEqual(await running, { ok: false, reason: 'internal', detail: 'closed' });
console.log('OK');
