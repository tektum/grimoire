// Shutdown with a conversion in flight and nothing else holding the event loop but what the shutdown itself holds.
// argv[2] = "hook" (the server's markdown-pool hook) or "bare" (close() called directly, as a control).
import { fileURLToPath } from 'node:url';
import { createMarkdownConverter } from '@tektum/grimoire-adapter-markdown-milkdown';
import { markdownPoolHook } from '../../../dist/composition.js';
import { DERIVED_BUDGETS_MS } from '../../../dist/lifecycle/budget.js';
import { Shutdown } from '../../../dist/lifecycle/shutdown.js';

const workerPath = fileURLToPath(new URL('./spin-worker.mjs', import.meta.url));
const converter = createMarkdownConverter({ workerPath, timeoutMs: 400, closeDeadlineMs: DERIVED_BUDGETS_MS.poolClose }); // the production pool close deadline, which the hook's own deadline must cover
const inFlight = converter.toMarkdown(new Uint8Array([1]));
await new Promise((r) => setTimeout(r, 100));
const lines = [];
const log = { info: (e, f) => lines.push({ e, ...f }), warn: (e, f) => lines.push({ e, ...f }), error: (e, f) => lines.push({ e, ...f }) };
if (process.argv[2] === 'hook') {
  const shutdown = new Shutdown({ now: () => Date.now() });
  shutdown.register(markdownPoolHook(converter));
  const code = await shutdown.run(log, 'test');
  const result = await inFlight;
  process.stdout.write(JSON.stringify({ code, result, hooks: lines.filter((l) => l.e.startsWith('shutdown.hook')).map((l) => l.e) }) + '\n');
} else {
  await converter.close();
  process.stdout.write('closed\n');
}
