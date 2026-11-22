import { RawClient, awarenessFrame } from '../raw.ts';
import { devToken, eventually, newPage, peer, scenario, synced, userIdOf } from '../support.ts';
import type { Peer } from '../support.ts';

// A forged client id, a forged removal, a wrong user.id and an oversize state are dropped; the sender is told (R4.12, H item 4).
await scenario('presence', 90_000, async (t) => {
  const page = await newPage();
  const alice = peer(page, 'alice'); const bob = peer(page, 'bob');
  const mallory = await RawClient.open(page, devToken('mallory', 'member'));
  t.onDone(() => { alice.destroy(); bob.destroy(); mallory.close(); });
  await Promise.all([synced(alice), synced(bob)]);
  // presence carries the database row id of the signed-in user (R4.12), not the token subject.
  const ids = { alice: await userIdOf('alice'), bob: await userIdOf('bob'), mallory: await userIdOf('mallory') };

  const stateOf = (viewer: Peer, id: number): Record<string, unknown> | undefined => viewer.provider.awareness?.getStates().get(id);
  const bobId = bob.doc.clientID;
  bob.provider.setAwarenessField('user', { id: ids.bob, name: 'Bob' });
  bob.provider.setAwarenessField('cursor', 3);
  await eventually(() => (stateOf(alice, bobId)?.['cursor'] === 3 ? true : undefined), 8000, 'alice to see bob');
  t.equal(stateOf(alice, bobId)?.['user'], { id: ids.bob, name: 'Bob' }, 'an honest state arrives with the checked user.id');

  const malloryId = 1_000_000_007; let clock = 0;
  const told = (): number => mallory.stateless.filter((m) => m.includes('presence-violation')).length;
  const probe = async (label: string, entries: readonly (readonly [number, number, unknown])[], violations: number): Promise<void> => {
    const were = told();
    mallory.send(awarenessFrame(page, entries));
    await eventually(() => (told() >= were + violations ? true : undefined), 8000, `${label}: the sender to be told`);
    t.check(told() === were + violations, `${label}: the sender is told presence-violation`);
  };
  // 1. mallory publishes honestly: accepted, and alice sees it.
  clock += 1;
  mallory.send(awarenessFrame(page, [[malloryId, clock, { user: { id: ids.mallory }, cursor: 1 }]]));
  await eventually(() => (stateOf(alice, malloryId)?.['cursor'] === 1 ? true : undefined), 8000, 'alice to see mallory');
  t.equal(stateOf(alice, malloryId)?.['user'], { id: ids.mallory }, 'an honest raw state is accepted');
  t.equal(told(), 0, 'an honest state draws no violation');

  // 2. a forged client id: a state for bob's id sent by mallory.
  clock += 1;
  await probe('forged client id', [[bobId, 10_000, { user: { id: ids.bob }, cursor: 999 }]], 1);
  // 3. a forged removal of bob's state.
  await probe('forged removal', [[bobId, 10_001, null]], 1);
  // 4. a wrong user.id on mallory's own state.
  clock += 1;
  await probe('wrong user.id', [[malloryId, clock, { user: { id: ids.alice }, cursor: 5 }]], 1);
  // 5. a state over the 4,096-byte cap.
  clock += 1;
  await probe('oversize state', [[malloryId, clock, { user: { id: ids.mallory }, pad: 'x'.repeat(5000) }]], 1);

  // Ordering probe: once a later honest update from mallory is visible, the forged frames before it have been handled.
  clock += 1;
  mallory.send(awarenessFrame(page, [[malloryId, clock, { user: { id: ids.mallory }, cursor: 77 }]]));
  // One socket from the server to alice delivers in order, so nothing forged can still be on its way to her.
  await eventually(() => (stateOf(alice, malloryId)?.['cursor'] === 77 ? true : undefined), 8000, 'the later honest update to arrive');
  t.equal(stateOf(alice, bobId)?.['cursor'], 3, "bob's state is unchanged for alice after the forged update and removal");
  t.equal(stateOf(alice, bobId)?.['user'], { id: ids.bob, name: 'Bob' }, "bob's user.id is unchanged for alice");
  t.equal(stateOf(alice, malloryId)?.['user'], { id: ids.mallory }, "mallory's user.id never became alice's");
  t.check(stateOf(alice, malloryId)?.['pad'] === undefined, 'the oversize state never reached alice');
  t.equal(told(), 4, 'exactly the four forged or oversize updates were refused');
  t.metric('violationsTold', told());
});
