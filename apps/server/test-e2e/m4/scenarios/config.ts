import { anonymous, apiWithToken, expectStatus, scenario } from '../support.ts';

// What a client needs before it signs in: GET /v1/config answers without a token, with the address of the collaboration server and the oldest client version the
// API accepts (R13.8). A token the server would refuse elsewhere does not change the answer.
await scenario('config', 60_000, async (t) => { // timeout: one request, no stack change
  const config = expectStatus(await anonymous().GET('/v1/config'), 200, 'GET /v1/config without a token');
  t.check(typeof config.collabUrl === 'string' && /^wss?:\/\/.+/.test(config.collabUrl), 'collabUrl is a WebSocket address');
  t.check(typeof config.minClientVersion === 'string' && /^\d+\.\d+\.\d+/.test(config.minClientVersion), 'minClientVersion is a version');
  t.equal(config.local, true, 'the stack runs in local mode');
  const refused = await anonymous().GET('/v1/me');
  t.equal(refused.response.status, 401, 'another route refuses a request with no token');
  const garbage = await apiWithToken('not-a-real-token').GET('/v1/config');
  t.equal(garbage.response.status, 200, 'the public route answers even with a token the server refuses elsewhere');
});
