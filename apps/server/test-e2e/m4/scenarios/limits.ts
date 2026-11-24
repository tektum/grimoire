import { recreateApp } from '../../m2/support.ts';
import { anonymous, apiAs, errorCode, scenario } from '../support.ts';

// The per-address limit comes before authentication (R13.8): requests with no token are answered 401 until the address has used its budget, and the next one is
// 429 `rate_limited` with Retry-After. A valid signed-in request never touches that counter (many people share one office address): it is limited per user only.
// The budget is the setting's default (GRIMOIRE_HTTP_ADDRESS_LIMIT_PER_MINUTE is not forwarded to the container by compose.yaml): if the default changes, this fails
// loudly and the number is changed with it. The app is recreated first, so the counters are fresh.
const LIMIT = 60;

await scenario('limits', 180_000, async (t) => { // timeout: recreates the app twice and sends about 60 requests
  t.onDone(async () => { await recreateApp({}); }); // the next scenarios start from fresh counters and the default settings
  await recreateApp({});
  const api = anonymous();
  let refusedAt = 0;
  let retryAfter: string | null = null;
  let code: string | undefined;
  for (let n = 1; n <= LIMIT + 10 && refusedAt === 0; n += 1) {
    const answer = await api.GET('/v1/me');
    if (answer.response.status === 429) { refusedAt = n; retryAfter = answer.response.headers.get('retry-after'); code = errorCode(answer); }
    else t.equal(answer.response.status, 401, `request ${String(n)} with no token is refused 401, not yet limited`);
  }
  // The harness's own readiness polls after the recreation count against the same address: the 61st request overall is the first refused, so the first refusal of this loop
  // comes at the 61st request or a few earlier, and never later.
  t.check(refusedAt >= LIMIT - 10 && refusedAt <= LIMIT + 1, `the address is refused 429 at request ${String(refusedAt)}, after its budget of ${String(LIMIT)}`);
  t.equal(code, 'rate_limited', 'the 429 carries the error code rate_limited');
  t.check(retryAfter !== null && Number(retryAfter) >= 1, 'the 429 says when to try again (Retry-After)');
  const withToken = await apiAs('alice').GET('/v1/me');
  t.equal(withToken.response.status, 200, 'a valid signed-in request is not held by the address counter');
});
