import { request } from 'node:http';
import { appEvents, eventually, newPage, peer, scenario, synced } from '../support.ts';

// A bad or missing Origin gets 403 and never reaches authentication: no collab.connected line (R12.15, H item 7).
function upgrade(origin: string | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: 8080, path: '/collab',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(origin === undefined ? {} : { Origin: origin }) },
    });
    req.on('response', (res) => { resolve(res.statusCode ?? 0); res.resume(); });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

await scenario('origin', 60_000, async (t) => {
  // collab.connected is logged for at most 10 connections per 10 s window (log-throttle.ts), and a window lies wholly inside the last 10 s:
  // start once those hold at most 8 lines, so earlier scenarios cannot crowd out the one line this scenario counts.
  await eventually(async () => ((await appEvents(new Date(Date.now() - 11_000))).filter((e) => e.event === 'collab.connected').length <= 8 ? true : undefined), 30_000, 'room in the collab.connected log window');
  const since = new Date(Date.now() - 1000);
  const page = await newPage();
  t.equal(await upgrade('http://evil.example'), 403, 'a bad Origin gets 403');
  t.equal(await upgrade(undefined), 403, 'a missing Origin gets 403');

  const bad = peer(page, 'mallory', 'member', { origin: 'http://evil.example' });
  t.onDone(() => { bad.destroy(); });
  // Two refused connection attempts: the first upgrade and the provider's own retry both ended without a sync.
  await eventually(() => (bad.closes.length >= 2 ? true : undefined), 15_000, 'the bad-Origin provider to be refused twice');
  t.check(!bad.provider.synced, 'a provider with a bad Origin never syncs');
  const good = peer(page, 'alice');
  t.onDone(() => { good.destroy(); });
  await synced(good);
  const connected = await eventually(async () => {
    const lines = (await appEvents(since)).filter((e) => e.event === 'collab.connected' && e['pageId'] === page);
    return lines.length > 0 ? lines : undefined;
  }, 10_000, 'the allowed client to be logged as connected');
  t.equal(connected.length, 1, 'exactly one collab.connected line for the page: the allowed client, not the bad Origin');
});
