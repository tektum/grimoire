import { randomUUID } from 'node:crypto';
import { createAttachments } from '@tektum/grimoire-adapter-db-kysely';
import { cleanupExpiredAttachments } from '@tektum/grimoire-core/attachments/cleanup';
import { apiFor, objectExists, pageIn, pngBytes, readyAttachment, runtimeDatabase, runtimeStore, scenario, sendToStore, signInAll, sql, startUpload } from '../support.ts';

// The clean-up of uploads that were never completed (R9.13), run directly: nothing schedules it in this milestone, so the scenario calls the use case of the application with
// the runtime database role and the runtime store key. An expired upload loses its object and its row; one that is still waiting, and one that was completed, keep both.
await scenario('cleanup', 180_000, async (t) => { // timeout: about 20 requests, three transfers to the store and one pass of the clean-up
  await signInAll();
  const open = await pageIn(true);
  const name = `clean-${randomUUID().slice(0, 8)}`;
  const user = apiFor(name);
  const me = (await user.GET('/v1/me')).data;
  if (me === undefined) throw new Error('the user did not sign in');
  const db = runtimeDatabase();
  t.onDone(async () => { await db.close(); });

  const bytes = pngBytes();
  const waiting = (await startUpload(user, open.page, bytes)).body;
  const expired = (await startUpload(user, open.page, bytes)).body;
  const completed = await readyAttachment(user, open.page, pngBytes());
  if (waiting === undefined || expired === undefined) throw new Error('uploads were not started');
  t.equal((await sendToStore(waiting.upload, bytes)).status, 200, 'the waiting upload has its object');
  t.equal((await sendToStore(expired.upload, bytes)).status, 200, 'the upload that will expire has its object');
  await sql(`update attachments set expires_at = now() - interval '1 minute' where id = '${expired.id}'`);

  const removed = await cleanupExpiredAttachments({ repo: createAttachments(db), files: runtimeStore(), tenantId: 'legacy', now: () => Date.now(), batch: 1000 });
  t.check(removed >= 1, `the clean-up removed ${String(removed)} expired upload(s), at least ours`);
  t.equal(await objectExists(expired.id), false, 'the expired upload lost its object');
  t.equal(Number((await sql(`select count(*) from attachments where id = '${expired.id}'`)).trim()), 0, 'and its row');
  t.equal([await objectExists(waiting.id), await objectExists(completed.id)], [true, true], 'the waiting upload and the completed one keep their objects');
  t.equal(Number((await sql(`select count(*) from attachments where id in ('${waiting.id}', '${completed.id}')`)).trim()), 2, 'and their rows');
  t.equal(await cleanupExpiredAttachments({ repo: createAttachments(db), files: runtimeStore(), tenantId: 'legacy', now: () => Date.now(), batch: 1000 }), 0, 'a second pass finds nothing');
});
