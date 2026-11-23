// Shutdown with a conversion in flight and nothing else holding the event loop but what the shutdown itself holds.
// argv[2] = "hook" (the server's markdown-pool hook), "bare" (close() called directly) or "deadline" (close() directly, with a call that outlasts its own limit, so only the close deadline can end it).
import { fileURLToPath } from 'node:url';
import { createMarkdownConverter } from '@tektum/grimoire-adapter-markdown-milkdown';
import { markdownPoolHook } from '../../../dist/composition.js';
import { DERIVED_BUDGETS_MS } from '../../../dist/lifecycle/budget.js';
import { Shutdown } from '../../../dist/lifecycle/shutdown.js';

const workerPath = fileURLToPath(new URL('./spin-worker.mjs', import.meta.url));
const deadlineMode = process.argv[2] === 'deadline';
const converter = createMarkdownConverter({ workerPath, timeoutMs: deadlineMode ? 20_000 : 400, closeDeadlineMs: deadlineMode ? 300 : DERIVED_BUDGETS_MS.poolClose }); // the production pool close deadline, which the hook's own deadline must cover
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
  const started = Date.now();
  await converter.close();
  process.stdout.write(`closed ${Date.now() - started}\n`);
}
