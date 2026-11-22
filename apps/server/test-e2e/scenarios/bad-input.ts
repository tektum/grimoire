import { Buffer } from 'node:buffer';
import * as Y from 'yjs';
import { RawClient, syncUpdateFrame } from '../raw.ts';
import { devToken, eventually, newPage, peer, scenario, storedState, storedText, synced, waitUntil } from '../support.ts';

// A 2 MB frame closes with 1009; malformed and truncated updates are refused; the page still loads (R4.16, R4.17, H item 3).
await scenario('bad-input', 90_000, async (t) => {
  const page = await newPage();
  const alice = peer(page, 'alice');
  t.onDone(() => { alice.destroy(); });
  await synced(alice);
  alice.text.insert(0, 'hello');
  await eventually(async () => ((await storedText(page)) === 'hello' ? true : undefined), 20_000, 'hello stored');
  const before = Buffer.from((await storedState(page)) ?? new Uint8Array()).toString('hex');

  const big = await RawClient.open(page, devToken('mallory', 'member'));
  t.onDone(() => { big.close(); });
  big.send(new Uint8Array(2 * 1024 * 1024));
  await eventually(() => big.closed, 8000, 'the oversize socket to be closed');
  t.equal(big.closed?.code, 1009, 'a 2 MB frame closes the socket with 1009');

  const valid = Y.encodeStateAsUpdate(alice.doc);
  const kinds: readonly [string, Uint8Array][] = [
    ['garbage', Uint8Array.from({ length: 64 }, (_, i) => 255 - (i % 7))],
    ['truncated', valid.slice(0, valid.length - 3)],
  ];
  for (const [kind, payload] of kinds) {
    const bad = await RawClient.open(page, devToken(`mallory-${kind}`, 'member'));
    t.onDone(() => { bad.close(); });
    bad.send(syncUpdateFrame(page, payload));
    await eventually(() => bad.stateless.find((m) => m.includes('malformed-update')), 8000, `${kind} update refused`);
    t.equal(JSON.parse(bad.stateless[0] ?? '{}'), { grimoire: 1, kind: 'refusal', code: 'malformed-update' }, `a ${kind} update is refused as malformed-update`);
  }
  // Negative window: a write would end it early; none may come within the 3 s save debounce after the bad input.
  const storedHex = async (): Promise<string> => Buffer.from((await storedState(page)) ?? new Uint8Array()).toString('hex');
  t.check(!(await waitUntil(async () => (await storedHex()) !== before, 4000)), 'nothing was stored within the save debounce after the bad input');
  t.equal(await storedHex(), before, 'nothing was stored for any of the bad input');

  alice.text.insert(5, '!');
  const fresh = peer(page, 'fresh');
  t.onDone(() => { fresh.destroy(); });
  await synced(fresh);
  await eventually(() => (fresh.text.toString() === 'hello!' ? true : undefined), 8000, 'fresh client to load the page');
  t.equal(fresh.text.toString(), 'hello!', 'the page still loads with its text for a new client');
  t.equal(alice.text.toString(), 'hello!', 'the honest client was not disturbed');
});
