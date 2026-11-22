import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createMarkdownConverter, seedInProcess } from '@tektum/grimoire-adapter-markdown-milkdown';
import { describe, it } from 'vitest';
import { requireBuild } from '../server/support/harness.js';

//, item 5 (measurement, not pass/fail): the largest Markdown of each shape that the pooled converter seeds with the production
// options (512 MB worker, 10 s, state cap 1,536,000), and the Markdown size at which the state reaches the cap.
const gen = {
  words: (kb: number) => 'The quick brown fox jumps over the lazy dog, again and again, with *emphasis* and `code` and a [link](https://example.com).\n\n'.repeat(Math.ceil((kb * 1024) / 121)),
  list: (kb: number) => Array.from({ length: Math.ceil((kb * 1024) / 18) }, (_, i) => `- item number ${String(i)}\n`).join(''),
  table: (kb: number) => `| a | b | c |\n|---|---|---|\n${Array.from({ length: Math.ceil((kb * 1024) / 20) }, (_, i) => `| ${String(i)} | cell | x |\n`).join('')}`,
};
type Kind = keyof typeof gen;

describe('seed limits', { timeout: 3_000_000 }, () => {
  it('measures', async () => {
    requireBuild();
    const out: Record<string, unknown> = {};
    const conv = createMarkdownConverter({ maxStateBytes: 1_536_000 });
    const tryPool = async (kind: Kind, kb: number) => {
      const md = gen[kind](kb);
      const t = performance.now();
      const r = await conv.seed(md, 'test-key');
      return { kb, bytes: Buffer.byteLength(md), ok: r.ok, reason: r.ok ? '' : r.reason, state: r.ok ? r.state.byteLength : 0, ms: Math.round(performance.now() - t) };
    };
    for (const kind of ['words', 'list', 'table'] as Kind[]) {
      const rows = [];
      let lo = 20; let hi = 1000;
      for (const kb of [50, 100, 200, 400, 700, 1000]) rows.push(await tryPool(kind, kb));
      // bisection on "seeds ok" between the last ok and the first failure
      const firstFail = rows.find((r) => !r.ok);
      const lastOk = [...rows].reverse().find((r) => r.ok && (!firstFail || r.kb < firstFail.kb));
      if (firstFail) { lo = lastOk?.kb ?? 20; hi = firstFail.kb; while (hi - lo > 10) { const mid = Math.floor((lo + hi) / 2); const r = await tryPool(kind, mid); rows.push(r); if (r.ok) lo = mid; else hi = mid; } }
      out[kind] = { rows, largestOkKb: firstFail ? lo : (lastOk?.kb ?? null), firstFailKb: firstFail ? hi : null, failReason: rows.find((r) => !r.ok)?.reason ?? null };
      // the size at which the state reaches the cap (in process, no cap), and whether the pool seeds that Markdown
      const probes = [];
      for (const kb of [50, 100, 200, 400]) { const md = gen[kind](kb); const r = await seedInProcess(md, { maxStateBytes: 200_000_000, maxBlocks: 100_000_000 }); probes.push({ kb, state: r.ok ? r.state.byteLength : -1 }); }
      out[`${kind}_stateProbe`] = probes;
    }
    const file = process.env['BENCH_OUT'] ?? 'test-results/seed-limits.json';
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(out)}\n`);
    await conv.close();
  });
});
