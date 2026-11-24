import { randomUUID } from 'node:crypto';
import { apiAs, errorCode, eventually, expectStatus, getFromStore, pageIn, pngBytes, scenario, sendToStore, signInAll, sql, startUpload, succeeded } from '../support.ts';

// A retry of a create with the same Idempotency-Key (R6.7, the signed address): the application keeps no signed address (the stored answer has no `X-Amz-` and no upload
// at all), and the retry gets a new address for the same attachment, which works; with another body the same key is refused.
await scenario('idempotent-create', 180_000, async (t) => { // timeout: about 15 requests, one transfer to the store and a wait for the clock to pass a second
  await signInAll();
  const bob = apiAs('bob');
  const open = await pageIn(true);
  const bytes = pngBytes();
  const key = `m5-${randomUUID()}`;

  const first = (await startUpload(bob, open.page, bytes, { fileName: 'same.png', key })).body;
  if (first === undefined) throw new Error('the first create was refused');
  const stored = await sql(`select response::text from idempotency_keys where response::text like '%${first.id}%'`);
  t.check(stored.includes(first.id), 'the answer is kept for the retry');
  t.equal([stored.includes('X-Amz-'), stored.includes('upload'), stored.includes(first.upload.url)], [false, false, false], 'what is kept holds no signed address, no X-Amz- and no upload');

  // The same request again, in a later second than the first signature (an address carries the second it was made in; the wait is for the clock to pass it, with no request
  // meanwhile: the create is limited per minute). Then the same attachment and Markdown path come back with a new address.
  const signedAt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(new URL(first.upload.url).searchParams.get('X-Amz-Date') ?? '');
  if (signedAt === null) throw new Error('the address carries no signing time');
  const signedMs = Date.UTC(Number(signedAt[1]), Number(signedAt[2]) - 1, Number(signedAt[3]), Number(signedAt[4]), Number(signedAt[5]), Number(signedAt[6]));
  await eventually(() => (Date.now() >= signedMs + 1000 ? true : undefined), 10_000, 'the clock to pass the second of the first address');
  const answer = await bob.POST('/v1/attachments', { body: { pageId: open.page, fileName: 'same.png', contentType: 'image/png', size: bytes.length }, headers: { 'idempotency-key': key } });
  t.equal(answer.response.status, 201, 'the retry is answered 201');
  t.equal(answer.response.headers.get('idempotent-replay'), 'true', 'as a replay');
  const replayed = answer.data;
  t.check(replayed !== undefined && replayed.upload.url !== first.upload.url, 'with a new address');
  if (replayed === undefined) throw new Error('no replay');
  t.equal([replayed.id, replayed.markdownPath], [first.id, first.markdownPath], 'the retry names the same attachment and path');
  t.equal((await sendToStore(replayed.upload, bytes)).status, 200, 'the new address works');
  succeeded(await bob.POST('/v1/attachments/{id}/complete', { params: { path: { id: first.id } } }), 'complete after the retry');
  t.equal((await getFromStore(expectStatus(await bob.GET('/v1/attachments/{id}', { params: { path: { id: first.id } } }), 200, 'a link').url)).status, 200, 'and the file downloads');

  const other = await bob.POST('/v1/attachments', { body: { pageId: open.page, fileName: 'other.png', contentType: 'image/png', size: bytes.length }, headers: { 'idempotency-key': key } });
  t.equal([other.response.status, errorCode(other)], [409, 'conflict'], 'the same key with another body is refused 409');
  t.equal(Number((await sql(`select count(*) from attachments where page_id = '${open.page}'`)).trim()), 1, 'one attachment exists for all of it');
});
