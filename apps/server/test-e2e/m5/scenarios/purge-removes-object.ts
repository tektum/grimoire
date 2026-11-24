import { apiAs, errorCode, expectStatus, objectExists, pageIn, pngBytes, readyAttachment, scenario, signInAll, sql, succeeded } from '../support.ts';

// A permanent delete removes the stored object (R9.15's counterpart, the purge of M4 with the store of M5): through the routes only, as an administrator would do it: delete
// the page, empty it from the trash, and the object is gone from the real store with its row.
await scenario('purge-removes-object', 180_000, async (t) => { // timeout: about 20 requests and two transfers to the store
  await signInAll();
  const alice = apiAs('alice');
  const bob = apiAs('bob');
  const open = await pageIn(true);
  const kept = await readyAttachment(bob, open.page, pngBytes());
  const second = await readyAttachment(bob, open.page, pngBytes());
  t.equal([await objectExists(kept.id), await objectExists(second.id)], [true, true], 'both objects are in the store');

  succeeded(await bob.DELETE('/v1/pages/{id}', { params: { path: { id: open.page } } }), 'bob deletes the page');
  t.equal([await objectExists(kept.id), await objectExists(second.id)], [true, true], 'deleting a page into the trash keeps its files');
  const refused = await bob.DELETE('/v1/trash/{id}', { params: { path: { id: open.page } } });
  t.equal([refused.response.status, errorCode(refused)], [403, 'forbidden'], 'a member cannot empty the trash');
  t.equal(await objectExists(kept.id), true, 'and nothing was removed');

  succeeded(await alice.DELETE('/v1/trash/{id}', { params: { path: { id: open.page } } }), 'the administrator empties the batch');
  t.equal([await objectExists(kept.id), await objectExists(second.id)], [false, false], 'both objects are gone from the store');
  t.equal(Number((await sql(`select count(*) from attachments where id in ('${kept.id}', '${second.id}')`)).trim()), 0, 'and no row is left');
  const answer = await alice.GET('/v1/attachments/{id}', { params: { path: { id: kept.id } } });
  t.equal([answer.response.status, errorCode(answer)], [404, 'not_found'], 'a download of either is not found');
  expectStatus(await alice.GET('/v1/me'), 200, 'the administrator is still signed in');
});
