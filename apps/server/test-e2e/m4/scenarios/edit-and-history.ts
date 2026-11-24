import { docPeer, EditorUser, peerSynced, typeInOwnParagraph } from '../../m2/support.ts';
import { apiAs, closeDb, eventually, expectStatus, openCollection, savedMarkdown, scenario, signInAll, throttled } from '../support.ts';

// Live editing leaves a history (R9.2): a person edits through an editor bound to the page's document, the page is saved, and when the last editor leaves a
// revision appears with that person as its author and the saved text as its content; a second sitting makes a second revision; restoring the first returns its
// text, writes no extra copy (the saved state is already the latest revision) and does not touch the live page.
await scenario('edit-and-history', 300_000, async (t) => { // timeout: two editing sittings, each waits for a save and for the last editor to leave
  t.onDone(closeDb);
  const ids = await signInAll();
  const bob = apiAs('bob');
  const collection = await openCollection('Exit M4 history');
  const page = expectStatus(await bob.POST('/v1/pages', { body: { collectionId: collection, title: 'History', markdown: '# History\n\nOwna start.\n\nOwnb start.\n' } }), 201, 'bob creates the page from Markdown');

  const live = new Set<string>();
  const sit = async (tag: string): Promise<readonly string[]> => { // each sitting has its own tag, so its tokens are new
    const before = new Set(live);
    const peer = docPeer(page.id, 'bob');
    try {
      await peerSynced(peer);
      const editor = new EditorUser(peer, tag, t.rng, live);
      await editor.open();
      typeInOwnParagraph(editor, 3);
      editor.close();
      const typed = [...live].filter((token) => !before.has(token));
      await eventually(throttled(async () => ((await savedMarkdown('bob', page.id)).includes(typed[typed.length - 1] ?? '\0') ? true : undefined)), 90_000, 'the edit to be saved');
      return typed;
    } finally {
      peer.destroy(); // the last editor leaves
    }
  };

  const first = await sit('a');
  const afterFirst = await eventually(throttled(async () => {
    const list = expectStatus(await bob.GET('/v1/pages/{id}/revisions', { params: { path: { id: page.id } } }), 200, 'the history after the first sitting');
    return list.items.length >= 1 ? list : undefined;
  }), 90_000, 'a revision after the last editor left');
  const revisionOne = afterFirst.items[0];
  t.equal(revisionOne?.reason, 'last_editor_left', 'the first revision is made when the last editor leaves');
  t.check(revisionOne?.authors.some((a) => a.id === ids.bob) === true && revisionOne.lastAuthor?.id === ids.bob, 'bob is among its authors and its last author');
  const oneBody = expectStatus(await bob.GET('/v1/pages/{id}/revisions/{rid}', { params: { path: { id: page.id, rid: revisionOne?.id ?? '' } } }), 200, 'the first revision with its Markdown');
  t.check(first.every((token) => oneBody.markdown.includes(token)), 'it holds the text bob typed');

  const second = await sit('b');
  const afterSecond = await eventually(throttled(async () => {
    const list = expectStatus(await bob.GET('/v1/pages/{id}/revisions', { params: { path: { id: page.id } } }), 200, 'the history after the second sitting');
    return list.items.length >= 2 ? list : undefined;
  }), 90_000, 'a second revision after the second sitting');
  const revisionTwo = afterSecond.items[0];
  t.equal(afterSecond.items[1]?.id, revisionOne?.id, 'the newest revision is listed first');
  const twoBody = expectStatus(await bob.GET('/v1/pages/{id}/revisions/{rid}', { params: { path: { id: page.id, rid: revisionTwo?.id ?? '' } } }), 200, 'the second revision with its Markdown');
  t.check([...first, ...second].every((token) => twoBody.markdown.includes(token)), 'the second revision holds both sittings');

  // Restore: a viewer cannot; the member gets the first text back, the safety copy is the latest revision, and the live page is not changed.
  const carolRestore = await apiAs('carol').POST('/v1/pages/{id}/revisions/{rid}/restore', { params: { path: { id: page.id, rid: revisionOne?.id ?? '' } } });
  t.check([403, 404].includes(carolRestore.response.status), 'a person who may not write cannot restore');
  const liveBefore = await savedMarkdown('bob', page.id);
  const restored = expectStatus(await bob.POST('/v1/pages/{id}/revisions/{rid}/restore', { params: { path: { id: page.id, rid: revisionOne?.id ?? '' } } }), 200, 'bob restores the first revision');
  t.equal(restored.markdown, oneBody.markdown, 'the first text comes back');
  t.check(!second.some((token) => restored.markdown.includes(token)), 'the second sitting is not in the restored text');
  t.equal(restored.safetyRevisionId, revisionTwo?.id, 'the saved state was already the latest revision: that one is the safety copy');
  t.equal(await savedMarkdown('bob', page.id), liveBefore, 'restoring does not change the live page');
  const final = expectStatus(await bob.GET('/v1/pages/{id}/revisions', { params: { path: { id: page.id } } }), 200, 'the history after the restore');
  t.equal(final.items.length, 2, 'no extra revision was written');
});
