import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCollabLog, createConversionGate, createSaver } from '@tektum/grimoire-adapter-collab-hocuspocus/testing';
import { convertInProcess, createMarkdownConverter, seedInProcess } from '@tektum/grimoire-adapter-markdown-milkdown';
import type { PooledMarkdownConverter } from '@tektum/grimoire-adapter-markdown-milkdown';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';

// The save path (the gate, the saver and the write it chooses), on the REAL converter in its worker pool: dense valid pages save with fresh Markdown.
// No database. The save through the page store on Postgres is tested in save-columns.int.test.ts.
const WIDE = { maxSeedMarkdownBytes: 1 << 26, maxSeedLines: 1e8, maxSeedLineMarkers: 1e5 };
let pool: PooledMarkdownConverter;
beforeAll(() => { pool = createMarkdownConverter({ poolSize: 2 }); });
afterAll(async () => { await pool.close(); });

const shapes: [string, string][] = [
  ['python listing, 2,500 lines', '```python\n' + 'def foo_bar_baz(a_b, c_d):\n    return a_b * c_d_e\n'.repeat(1_250) + '```\n'],
  ['pretty JSON, 150 KB', '```json\n' + '  {"a_b": [1, 2, {"c": "d_e"}], "f": "*g*"},\n'.repeat(3_300) + '```\n'],
  ['task list, 3,000 items', '- [ ] task *a* done_x\n'.repeat(3_000)],
  ['table, 1,000 rows with links', '| h | h | h | h | h | h |\n|---|---|---|---|---|---|\n' + '| [a](http://x.y/1) | [b](u) | [c](u) | [d](u) | [e](u) | [f](u) |\n'.repeat(1_000)],
];

describe('saving through the gate and the saver with the real converter', () => {
  it.each(shapes)('%s: converted, written with fresh Markdown, no failure logged, breaker not involved', async (_name, markdown) => {
    const seeded = await seedInProcess(markdown, WIDE);
    if (!seeded.ok) throw new Error(seeded.detail);
    const logger = new FakeLogger();
    const saver = createSaver({ converter: createConversionGate(pool, { concurrency: 2 }), log: createCollabLog(logger) });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seeded.state);
    const state = Y.encodeStateAsUpdate(doc);
    const converted = await saver.convert('page-1', state);
    if (!converted.ok) throw new Error(`save refused: ${converted.reason}`);
    const write = saver.toWrite(converted, { state, epoch: 0, editedAt: 1 } as never);
    // The write carries exactly what the converter wrote for this state (the reference is the same converter run in process), and the state itself.
    const reference = await convertInProcess(state);
    if (!reference.ok) throw new Error(`reference conversion refused: ${reference.reason}`);
    expect(write).toMatchObject({ kind: 'converted', markdown: reference.markdown, text: reference.text, state, epoch: 0 });
    expect(converted.markdown).toBe(reference.markdown);
    expect(logger.entries.filter((e) => e.event === 'collab.convert_failed')).toEqual([]);
    // The breaker was not involved: it neither opened nor closed, and the saver never answered "breaker-open".
    expect(logger.entries.filter((e) => String(e.event).startsWith('collab.convert_breaker'))).toEqual([]);
    expect(converted.convertMs).toBeLessThan(10_000);
  }, 60_000);
});
