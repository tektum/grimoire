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

const tally = { checked: 0, notSaved: 0, timedOut: 0, smallIdOverLimit: [] as string[] };
const STATE_LIMIT = 1_000_000;
/** The identity the system re-seed gives its state: five bytes as a varint. */
const SYSTEM_CLIENT_ID = 3_000_000_000;

/**
 * The states under test are built with FIXED client identities, never a random one. A Yjs update writes the client id with every reference to an earlier item,
 * so the size of a state depends on how many bytes the id takes as a varint: the lists input of 100000 bytes is 1,065,116 bytes with a five-byte id and 960,594 with a
 * three-byte one, against a limit of 1,000,000. With a random id, one run in 2048 drew a small one, and the flake was this: the state fit the limit and was stored, while
 * the same Markdown re-seeded with the system's five-byte id did not. Both kinds of id are covered, deterministically:
 *  - the five-byte id (the same as the re-seed's): every state that is stored must be rebuilt, no exception;
 *  - a three-byte id: the same, except for the one case the size of the id explains, counted and checked below (the state fits with the small id, the same Markdown does not
 *    fit with the system's id). That is a limit of the product at the edge of the state limit, not of the test.
 */
const BIG_ID = 3_000_000_001;
const SMALL_ID = 2_097_147;

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
    // The one explained exception: this state fits only because its client id is small. Checked, not assumed: the same Markdown built with the system's id must really be over the limit.
    if (rebuilt.reason === 'too-large' && state.byteLength <= STATE_LIMIT && (await stateFromMarkdownDirect(saved.markdown, SYSTEM_CLIENT_ID)).byteLength > STATE_LIMIT) {
      tally.smallIdOverLimit.push(key);
      return;
    }
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

  it.each(SHAPES.flatMap((shape) => [30_000, 100_000, 200_000].flatMap((bytes) => [BIG_ID, SMALL_ID].map((id) => [shape, bytes, id] as const))))('%s, %d bytes of Markdown, client id %d', async (shape, bytes, id) => {
    // No size limit applies to building the state (a state over the limit is refused by the save, and counted there); a Markdown that cannot be parsed throws, and fails.
    const state = await stateFromMarkdownDirect(generateMarkdown(shape, bytes), id);
    await check(state, `${shape}-${bytes}-${id}`);
  }, 300_000);

  it('builds the same states every time: the same Markdown and client id give the same bytes', async () => {
    for (const shape of SHAPES) {
      const first = await stateFromMarkdownDirect(generateMarkdown(shape, 30_000), BIG_ID);
      const second = await stateFromMarkdownDirect(generateMarkdown(shape, 30_000), BIG_ID);
      expect(Buffer.from(second).equals(Buffer.from(first)), `${shape}`).toBe(true);
    }
  }, 120_000);

  it('reports its counts', () => {
    console.log(`save-then-reseed: checked ${tally.checked}, not saved (limits) ${tally.notSaved}, stopped by time ${tally.timedOut}, small id over the limit with the system id ${tally.smallIdOverLimit.join(', ')}`);
    expect(tally.checked).toBeGreaterThan(40);
    expect(tally.timedOut).toBe(0);
    // Exactly the inputs whose state is within the size of the id of the limit: with the three-byte id they fit, with the system's they do not. A new entry here is a new finding.
    expect(tally.smallIdOverLimit.sort()).toEqual(['lists-100000-2097147', 'mixed-200000-2097147']);
  });
});
