import { apiAs, errorCode, expectStatus, scenario, signInAll, unique } from '../support.ts';

// A working session through the generated client only (R13.8): the administrator makes a collection and shares it, a member builds a page tree, moves a page,
// deletes it and takes it back from the trash, a viewer reads what the collection's default permission lets them read and cannot write; every refusal is the envelope the
// contracts name. Nothing here edits a page live: the live editing and the history it leaves are the scenario `edit-and-history`.
await scenario('session', 240_000, async (t) => { // timeout: about 50 requests and a few round trips of the converter
  const ids = await signInAll();
  const alice = apiAs('alice');
  const bob = apiAs('bob');
  const carol = apiAs('carol');

  // The collection: administrators only.
  const refusedCreate = await bob.POST('/v1/collections', { body: { name: unique('Not allowed') } });
  t.equal([refusedCreate.response.status, errorCode(refusedCreate)], [403, 'forbidden'], 'a member cannot create a collection');
  const collection = expectStatus(await alice.POST('/v1/collections', { body: { name: unique('Exit M4') } }), 201, 'the administrator creates a collection');
  t.equal(collection.myPermission, 'read-write', 'the administrator may write in it');
  const hidden = await bob.GET('/v1/collections/{id}', { params: { path: { id: collection.id } } });
  t.equal([hidden.response.status, errorCode(hidden)], [404, 'not_found'], 'a collection nobody shared is not found by a member');

  // Sharing: an entry for one person, then a default permission for everyone.
  const entry = expectStatus(
    await alice.PUT('/v1/collections/{id}/access', { params: { path: { id: collection.id } }, body: { principalType: 'user', principalId: ids.bob, permission: 'read_write' } }),
    200, 'the administrator gives bob write access',
  );
  const again = expectStatus(
    await alice.PUT('/v1/collections/{id}/access', { params: { path: { id: collection.id } }, body: { principalType: 'user', principalId: ids.bob, permission: 'read_write' } }),
    200, 'the same entry again',
  );
  t.equal(again.id, entry.id, 'the same person keeps one entry');
  const seen = expectStatus(await bob.GET('/v1/collections/{id}', { params: { path: { id: collection.id } } }), 200, 'bob reads the collection');
  t.equal(seen.myPermission, 'read-write', 'bob may write in it');
  t.equal((await carol.GET('/v1/collections/{id}', { params: { path: { id: collection.id } } })).response.status, 404, 'carol cannot see it yet');
  expectStatus(await alice.PATCH('/v1/collections/{id}', { params: { path: { id: collection.id } }, body: { defaultPermission: 'read' } }), 200, 'the administrator lets everyone read');
  const carolSees = expectStatus(await carol.GET('/v1/collections/{id}', { params: { path: { id: collection.id } } }), 200, 'carol reads the collection');
  t.equal(carolSees.myPermission, 'read-only', 'the viewer may only read');

  // Pages: a parent with a child made from Markdown, and a second page.
  const root = expectStatus(await bob.POST('/v1/pages', { body: { collectionId: collection.id, title: 'Root', markdown: '# Root\n\nThe first page.\n' } }), 201, 'bob creates the first page');
  const child = expectStatus(await bob.POST('/v1/pages', { body: { collectionId: collection.id, parentId: root.id, title: 'Child' } }), 201, 'bob creates a child page');
  const other = expectStatus(await bob.POST('/v1/pages', { body: { collectionId: collection.id, title: 'Other', afterId: root.id } }), 201, 'bob creates a page after the first');
  t.check(root.position < other.position, 'a page made after another sorts after it');
  const refusedPage = await carol.POST('/v1/pages', { body: { collectionId: collection.id, title: 'Viewer page' } });
  t.equal([refusedPage.response.status, errorCode(refusedPage)], [403, 'forbidden'], 'a viewer cannot create a page');
  const patched = expectStatus(await bob.PATCH('/v1/pages/{id}', { params: { path: { id: root.id } }, body: { title: 'Root page', icon: 'book' } }), 200, 'bob renames the first page');
  t.equal([patched.title, patched.icon], ['Root page', 'book'], 'the title and the icon changed');
  const full = expectStatus(await carol.GET('/v1/pages/{id}', { params: { path: { id: child.id } } }), 200, 'carol reads the child page');
  t.equal(full.breadcrumb.map((b) => b.title), ['Root page'], 'the breadcrumb names the parent');
  t.equal(full.myPermission, 'read-only', 'the viewer reads the page read-only');
  const byUrl = expectStatus(await bob.GET('/v1/pages/by-url-id/{urlId}', { params: { path: { urlId: root.urlId } } }), 200, 'the first page by its URL id');
  t.equal(byUrl.id, root.id, 'the URL id leads to the same page');

  // Moving: the child to the top level after the first page; the tree shows it.
  const moved = expectStatus(await bob.POST('/v1/pages/{id}/move', { params: { path: { id: child.id } }, body: { parentId: null, afterId: root.id } }), 200, 'bob moves the child to the top level');
  t.equal(moved.parentId, null, 'the child is a top-level page now');
  const cycle = await bob.POST('/v1/pages/{id}/move', { params: { path: { id: root.id } }, body: { parentId: root.id } });
  t.equal([cycle.response.status, errorCode(cycle)], [409, 'would_create_cycle'], 'a page cannot be moved under itself');
  const tree = expectStatus(await carol.GET('/v1/collections/{id}/tree', { params: { path: { id: collection.id } } }), 200, 'carol reads the tree');
  t.equal(tree.pages.filter((p) => p.parentId === null).map((p) => p.id), [root.id, child.id, other.id], 'the tree lists the top-level pages in order');

  // Deleting and taking back: the page leaves the tree, shows in the trash, and returns.
  t.equal((await bob.DELETE('/v1/pages/{id}', { params: { path: { id: other.id } } })).response.status, 204, 'bob deletes the second page');
  t.equal((await carol.GET('/v1/pages/{id}', { params: { path: { id: other.id } } })).response.status, 404, 'a deleted page is not found');
  const afterDelete = expectStatus(await bob.GET('/v1/collections/{id}/tree', { params: { path: { id: collection.id } } }), 200, 'the tree after the delete');
  t.check(!afterDelete.pages.some((p) => p.id === other.id), 'the deleted page is gone from the tree');
  const trash = expectStatus(await bob.GET('/v1/trash', { params: { query: { collectionId: collection.id } } }), 200, 'bob reads the trash of the collection');
  t.check(trash.items.some((i) => i.id === other.id), 'the trash lists the deleted page');
  const back = expectStatus(await bob.POST('/v1/trash/{id}/restore', { params: { path: { id: other.id } } }), 200, 'bob takes the page back');
  t.equal(back.id, other.id, 'the restored page is the same page');
  const afterRestore = expectStatus(await carol.GET('/v1/collections/{id}/tree', { params: { path: { id: collection.id } } }), 200, 'the tree after the restore');
  t.check(afterRestore.pages.some((p) => p.id === other.id), 'the restored page is back in the tree');

  // History: a page nobody edited live has no revisions yet; an unknown revision is not found.
  const history = expectStatus(await bob.GET('/v1/pages/{id}/revisions', { params: { path: { id: root.id } } }), 200, 'bob reads the history of the first page');
  t.check(Array.isArray(history.items), 'the history is a list');
  const unknown = await bob.GET('/v1/pages/{id}/revisions/{rid}', { params: { path: { id: root.id, rid: '00000000-0000-4000-8000-000000000999' } } });
  t.equal([unknown.response.status, errorCode(unknown)], [404, 'not_found'], 'an unknown revision is not found');
  const viewerRestore = await carol.POST('/v1/pages/{id}/revisions/{rid}/restore', { params: { path: { id: root.id, rid: '00000000-0000-4000-8000-000000000999' } } });
  t.equal(viewerRestore.response.status, 403, 'a viewer cannot restore a revision');

  // The administrator ends the session by deleting the collection: it leaves every list, and so do its pages.
  t.equal((await alice.DELETE('/v1/collections/{id}', { params: { path: { id: collection.id } } })).response.status, 204, 'the administrator deletes the collection');
  const listed = expectStatus(await bob.GET('/v1/collections'), 200, 'bob lists the collections');
  t.check(!listed.items.some((c) => c.id === collection.id), 'the deleted collection is gone from the list');
  t.equal((await bob.GET('/v1/pages/{id}', { params: { path: { id: root.id } } })).response.status, 404, 'its pages are gone with it');
});
