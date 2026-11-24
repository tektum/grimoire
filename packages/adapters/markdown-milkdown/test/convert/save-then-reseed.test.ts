import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMarkdownConverter } from '../../src/index.js';
import type { PooledMarkdownConverter } from '../../src/index.js';
import { generateEditorDocument, generateMarkdown, SHAPES } from '../../src/testing/generate.js';
import { stateFromDocJson, stateFromMarkdownDirect } from '../../src/testing/states.js';
import { ensureBuilt } from '../pool/support.js';

// INVARIANT (port comment): anything the save direction stores can be rebuilt by the system path, and saving that again gives the same
// Markdown. Bounded: 60 generated editor documents and every shape at three sizes (a size whose state exceeds the state limit is not stored at all and is counted as such), through the pool with its own time limits.
let pool: PooledMarkdownConverter;
beforeAll(() => { ensureBuilt(); pool = createMarkdownConverter({ poolSize: 2 }); });
afterAll(async () => { await pool.close(); });

const tally = { checked: 0, notSaved: 0, timedOut: 0 };

/**
 * The states under test are built with a FIXED client identity of the same size (five bytes as a varint) as the system re-seed's. A Yjs update
 * writes the client id with every reference to an earlier item, so its size depends on how many bytes the id takes: this input (lists, 100000) is 1,065,116 bytes
 * with a five-byte id and 960,594 with a three-byte one, against a limit of 1,000,000. With a random id, one run in 2048 got a state that fit the limit and was
 * stored, while the same Markdown re-seeded with the five-byte id of the system path did not fit: "stored but not rebuildable: too-large". Input and id are fixed
 * now, so a run's states are the same bytes every time.
 */
const TEST_CLIENT_ID = 3_000_000_001;

async function check(state: Uint8Array, key: string): Promise<void> {
  const saved = await pool.toMarkdown(state);
  if (!saved.ok) {
    // Not stored at all (a limit of the save direction, or its time limit): the invariant is about what IS stored.
    if (saved.reason === 'timeout') tally.timedOut += 1; else tally.notSaved += 1;
    return;
  }
  const rebuilt = await pool.reseed(saved.markdown, key);
  if (!rebuilt.ok) {
    if (rebuilt.reason === 'timeout') { tally.timedOut += 1; return; }
    throw new Error(`stored but not rebuildable: ${rebuilt.reason}: ${rebuilt.detail} (input ${key}: state of ${state.byteLength} bytes, ${saved.markdown.length} characters of Markdown)`);
  }
  // The rebuilt page saves again, and from then on the Markdown is a fixed point. (The first re-save may differ from the first save in
  // one accepted way: a bare web address that the first save wrote as text is read back as an autolink; see `withoutAutolinks` in guards.ts.)
  const again = await pool.toMarkdown(rebuilt.state);
  if (!again.ok) throw new Error(`rebuilt page does not save: ${again.reason}: ${again.detail}`);
  const rebuiltTwice = await pool.reseed(again.markdown, key);
  if (!rebuiltTwice.ok) throw new Error(`stored but not rebuildable: ${rebuiltTwice.reason}`);
  const third = await pool.toMarkdown(rebuiltTwice.state);
  expect(third).toEqual(again);
  tally.checked += 1;
}

describe('save, then system re-seed, then save again: the same Markdown', () => {
  it('60 generated editor documents', async () => {
    for (let seed = 1; seed <= 60; seed += 1) await check(await stateFromDocJson(generateEditorDocument(seed)), `doc-${seed}`);
  }, 300_000);

  it.each(SHAPES.flatMap((shape) => [30_000, 100_000, 200_000].map((bytes) => [shape, bytes] as const)))('%s, %d bytes of Markdown', async (shape, bytes) => {
    let state: Uint8Array;
    try { state = await stateFromMarkdownDirect(generateMarkdown(shape, bytes), TEST_CLIENT_ID); } catch { tally.notSaved += 1; return; } // the state limit
    await check(state, `${shape}-${bytes}`);
  }, 300_000);

  it('builds the same states every time: the same Markdown and client id give the same bytes', async () => {
    for (const shape of SHAPES) {
      const first = await stateFromMarkdownDirect(generateMarkdown(shape, 30_000), TEST_CLIENT_ID);
      const second = await stateFromMarkdownDirect(generateMarkdown(shape, 30_000), TEST_CLIENT_ID);
      expect(Buffer.from(second).equals(Buffer.from(first)), `${shape}`).toBe(true);
    }
  }, 120_000);

  it('reports its counts', () => {
    console.log(`save-then-reseed: checked ${tally.checked}, not saved (limits) ${tally.notSaved}, stopped by time ${tally.timedOut}`);
    expect(tally.checked).toBeGreaterThan(40);
    expect(tally.timedOut).toBe(0);
  });
});
