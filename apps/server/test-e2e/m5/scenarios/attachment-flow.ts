import { apiAs, errorCode, expectStatus, getFromStore, objectExists, pageIn, publicEndpoint, readyAttachment, scenario, sendToStore, signInAll, startUpload, succeeded } from '../support.ts';
import { pngBytes } from '../support.ts';

// The whole life of an attachment through the generated client (R9.15, R12.11): created, sent to the store with the signed address, completed, downloaded with bytes equal;
// a person without access to the page gets 404, and a page in the trash gives 404.
await scenario('attachment-flow', 180_000, async (t) => { // timeout: about 40 requests and six transfers to the store
  await signInAll();
  const alice = apiAs('alice');
  const bob = apiAs('bob');
  const carol = apiAs('carol');
  const open = await pageIn(true);
  const hidden = await pageIn(false);
  const bytes = pngBytes();

  const started = (await startUpload(bob, open.page, bytes, { fileName: 'photo one.png' })).body;
  if (started === undefined) throw new Error('bob could not start an upload');
  t.equal(started.upload.method, 'PUT', 'the answer is a signed PUT');
  t.equal(new URL(started.upload.url).origin, new URL(publicEndpoint).origin, 'the address is the one a browser reaches');
  t.check(started.markdownPath.startsWith(`attachments/${started.id}/`), 'the Markdown path names the attachment');
  t.equal(await objectExists(started.id), false, 'nothing is stored before the bytes are sent');
  const early = await bob.GET('/v1/attachments/{id}', { params: { path: { id: started.id } } });
  t.equal([early.response.status, errorCode(early)], [404, 'not_found'], 'an upload that is not completed has no download');

  const sent = await sendToStore(started.upload, bytes);
  t.equal(sent.status, 200, 'the store accepts the bytes');
  const ready = expectStatus(await bob.POST('/v1/attachments/{id}/complete', { params: { path: { id: started.id } } }), 200, 'bob completes the upload');
  t.equal([ready.id, ready.size, ready.pageId], [started.id, bytes.length, open.page], 'the answer is the attachment');
  t.equal((await bob.POST('/v1/attachments/{id}/complete', { params: { path: { id: started.id } } })).response.status, 200, 'completing again is the same answer');

  const link = expectStatus(await carol.GET('/v1/attachments/{id}', { params: { path: { id: started.id } } }), 200, 'carol, who may read the page, gets a link');
  const got = await getFromStore(link.url);
  t.equal(got.status, 200, 'the store serves the link');
  t.equal(Buffer.from(await got.arrayBuffer()).equals(Buffer.from(bytes)), true, 'the bytes downloaded equal the bytes uploaded');
  t.check((got.headers.get('content-disposition') ?? '').startsWith('inline'), 'an image is shown inline');
  const asDownload = expectStatus(await carol.GET('/v1/attachments/{id}', { params: { path: { id: started.id }, query: { download: 'true' } } }), 200, 'a download is asked for');
  t.check((((await getFromStore(asDownload.url)).headers.get('content-disposition')) ?? '').startsWith('attachment'), 'the download is an attachment');

  // No access to the page: not found, whatever the person asks for.
  const refusedStart = await bob.POST('/v1/attachments', { body: { pageId: hidden.page, fileName: 'x.png', contentType: 'image/png', size: bytes.length } });
  t.equal([refusedStart.response.status, errorCode(refusedStart)], [404, 'not_found'], 'a member who cannot see the page cannot start an upload on it');
  const secret = await readyAttachment(alice, hidden.page, pngBytes());
  for (const [who, api] of [['bob', bob], ['carol', carol]] as const) {
    const refused = await api.GET('/v1/attachments/{id}', { params: { path: { id: secret.id } } });
    t.equal([refused.response.status, errorCode(refused)], [404, 'not_found'], `${who} gets 404 for an attachment of a page they cannot see`);
  }
  const many = expectStatus(await bob.POST('/v1/attachments/urls', { body: { ids: [started.id, secret.id] } }), 200, 'bob asks for two links at once');
  t.equal(many.urls.map((u) => u.id), [started.id], 'the link of the attachment bob cannot read is left out');

  // A page in the trash: nobody gets its files.
  succeeded(await bob.DELETE('/v1/pages/{id}', { params: { path: { id: open.page } } }), 'bob deletes the page');
  for (const [who, api] of [['bob', bob], ['carol', carol]] as const) {
    const gone = await api.GET('/v1/attachments/{id}', { params: { path: { id: started.id } } });
    t.equal([gone.response.status, errorCode(gone)], [404, 'not_found'], `${who} gets 404 for an attachment of a page in the trash`);
  }
});
