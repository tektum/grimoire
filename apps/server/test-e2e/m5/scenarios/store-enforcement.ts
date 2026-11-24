import { objectExists, pngBytes, runtimeStore, scenario, sendToStore, pageIn, startUpload, signInAll, apiAs, succeeded } from '../support.ts';

// What the store itself enforces, with no help from the application (R9.12): the exact size, the declared type, the headers that were signed, and create-only. Also the
// keys (R2.48): the port refuses a path segment over 255 bytes, the store keeps one of exactly 255, and the keys of the product never hold a name.
await scenario('store-enforcement', 180_000, async (t) => { // timeout: about 20 requests and eight transfers to the store
  await signInAll();
  const bob = apiAs('bob');
  const open = await pageIn(true);
  const bytes = pngBytes();
  const started = (await startUpload(bob, open.page, bytes)).body;
  if (started === undefined) throw new Error('bob could not start an upload');
  const { upload } = started;

  const bigger = await sendToStore(upload, Uint8Array.from([...bytes, 1]));
  t.check(bigger.status >= 400 && bigger.status < 500, `one byte more than declared is refused (${String(bigger.status)})`);
  const smaller = await sendToStore(upload, bytes.slice(0, bytes.length - 1));
  t.check(smaller.status >= 400 && smaller.status < 500, `one byte less than declared is refused (${String(smaller.status)})`);
  const other = await sendToStore(upload, bytes, { ...upload.headers, 'content-type': 'text/html' });
  t.check(other.status >= 400 && other.status < 500, `another content type than signed is refused (${String(other.status)})`);
  const withoutCreateOnly = Object.fromEntries(Object.entries(upload.headers).filter(([name]) => name.toLowerCase() !== 'if-none-match'));
  const unguarded = await sendToStore(upload, bytes, withoutCreateOnly);
  t.check(unguarded.status >= 400 && unguarded.status < 500, `a request without the create-only header is refused (${String(unguarded.status)})`);
  t.equal(await objectExists(started.id), false, 'none of the refused requests stored anything');

  t.equal((await sendToStore(upload, bytes)).status, 200, 'the exact bytes, with the signed headers, are stored');
  t.equal((await sendToStore(upload, pngBytes())).status, 412, 'a second PUT to the same address is refused 412: nothing is overwritten');
  succeeded(await bob.POST('/v1/attachments/{id}/complete', { params: { path: { id: started.id } } }), 'the attachment completes with the first bytes');

  // Keys: a segment of 256 bytes is refused before any request; one of 255 is stored; the product's keys are the id and nothing else.
  const store = runtimeStore();
  const longName = 'k'.repeat(255);
  const keyBase = `e2e/${started.id}`;
  const refused = await store.put(`${keyBase}/${'k'.repeat(256)}`, Uint8Array.of(1), { size: 1, contentType: 'application/octet-stream' }).then(() => 'stored', (e: unknown) => (e as { kind?: string }).kind);
  t.equal(refused, 'invalid-key', 'the port refuses a path segment of 256 bytes');
  await store.put(`${keyBase}/${longName}`, Uint8Array.of(1), { size: 1, contentType: 'application/octet-stream' });
  t.equal((await store.head(`${keyBase}/${longName}`)).size, 1, 'the store keeps a segment of exactly 255 bytes');
  await store.delete(`${keyBase}/${longName}`);
  const withLongName = (await startUpload(bob, open.page, bytes, { fileName: `${'n'.repeat(300)}.png` })).body;
  if (withLongName === undefined) throw new Error('a long file name was refused');
  t.equal(withLongName.markdownPath.split('/').at(-1)?.length, 255, 'the file name in the Markdown path is cut to 255 bytes');
});
