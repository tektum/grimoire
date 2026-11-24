import { randomUUID } from 'node:crypto';
import { apiFor, errorCode, pageIn, pngBytes, scenario, signInAll, sql, startUpload } from '../support.ts';

// The cap on uploads that wait for their completion (R9.13): a user may have 10 (the default, nothing is set here); the eleventh is 429 `rate_limited`; the cap is the
// user's own; and when the waiting uploads have expired they no longer count, so the user can start again. Expiry is set with SQL as the administrator role.
await scenario('pending-cap', 180_000, async (t) => { // timeout: about 40 requests and two commands in the database
  await signInAll();
  const open = await pageIn(true);
  const name = `cap-${randomUUID().slice(0, 8)}`;
  const user = apiFor(name);
  const other = apiFor(`${name}-other`);
  const bytes = pngBytes();
  const me = (await user.GET('/v1/me')).data;
  if (me === undefined) throw new Error('the user did not sign in');

  const first: string[] = [];
  for (let n = 1; n <= 10; n += 1) {
    const { answer, body } = await startUpload(user, open.page, bytes);
    t.equal(answer.response.status, 201, `upload ${String(n)} of 10 is started`);
    if (body !== undefined) first.push(body.id);
  }
  const eleventh = await startUpload(user, open.page, bytes);
  t.equal([eleventh.answer.response.status, errorCode(eleventh.answer)], [429, 'rate_limited'], 'the eleventh waiting upload is refused 429 rate_limited');
  t.equal((await startUpload(other, open.page, bytes)).answer.response.status, 201, 'another user is not held by it');

  await sql(`update attachments set expires_at = now() - interval '1 minute' where uploader_id = '${me.id}' and status = 'pending'`);
  const again = await startUpload(user, open.page, bytes);
  t.equal(again.answer.response.status, 201, 'with the waiting uploads expired the user starts again');
  const expired = Number((await sql(`select count(*) from attachments where uploader_id = '${me.id}' and expires_at < now()`)).trim());
  t.equal(expired, 10, 'the ten expired rows are still there until the clean-up removes them');
});
