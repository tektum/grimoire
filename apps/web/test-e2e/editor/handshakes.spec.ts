import { EventEmitter } from 'node:events';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { traceHandshakes } from './handshakes';

// The handshake recorder's failure messages (no stack, no browser: a page that is only the events the recorder listens to). A wait that ends without a handshake must say whether the page opened no socket
// at all, or a socket that sent no token, and what the page's console said: so that a failure on a slow runner names its cause.
const token = (fields: object): string => `g1.${Buffer.from(JSON.stringify(fields)).toString('base64url')}`;

function fakePage() {
  const page = new EventEmitter();
  const socket = (url: string) => {
    const s = new EventEmitter() as EventEmitter & { url: () => string };
    s.url = () => url;
    page.emit('websocket', s);
    return s;
  };
  return { page: page as unknown as Page, emit: page.emit.bind(page), socket };
}

test('a handshake is recorded from a frame the page sent, with the sockets and frames counted', async () => {
  const f = fakePage();
  const trace = traceHandshakes(f.page);
  const s = f.socket('ws://127.0.0.1:1/collab?secret=do-not-print');
  s.emit('framesent', { payload: 'hello' });
  s.emit('framesent', { payload: `auth ${token({ t: 'tok', v: '1.2.3' })}` });
  await trace.waitFor(1, 1000);
  expect(trace.handshakes).toEqual([{ t: 'tok', v: '1.2.3' }]);
  expect([trace.sockets.length, trace.frames]).toEqual([1, 2]);
});

test('no socket at all is said so, with the console errors of the page and without the query of an address', async () => {
  const f = fakePage();
  const trace = traceHandshakes(f.page);
  f.emit('console', { type: () => 'error', text: () => 'Failed to load resource: net::ERR_CONNECTION_REFUSED' });
  f.emit('pageerror', new Error('boom'));
  const error = await trace.waitFor(1, 300).then(
    () => undefined,
    (e: Error) => e,
  );
  expect(error?.message).toContain('no websocket was opened');
  expect(error?.message).toContain('ERR_CONNECTION_REFUSED');
  expect(error?.message).toContain('boom');
});

test('a socket that sent no token is said so: how many sockets and frames, with the addresses without their query', async () => {
  const f = fakePage();
  const trace = traceHandshakes(f.page);
  const s = f.socket('ws://127.0.0.1:9/collab?secret=do-not-print');
  s.emit('framesent', { payload: 'a frame without the token' });
  s.emit('close');
  const error = await trace.waitFor(1, 300).then(
    () => undefined,
    (e: Error) => e,
  );
  expect(error?.message).toContain('1 websocket was opened');
  expect(error?.message).toContain('1 frame');
  expect(error?.message).toContain('closed');
  expect(error?.message).toContain('ws://127.0.0.1:9/collab');
  expect(error?.message).not.toContain('do-not-print');
});

test('it waits for as many handshakes as asked, and a count that is only reached late is reached', async () => {
  const f = fakePage();
  const trace = traceHandshakes(f.page);
  const s = f.socket('ws://x/collab');
  s.emit('framesent', { payload: token({ t: 'a' }) });
  setTimeout(() => s.emit('framesent', { payload: token({ t: 'b' }) }), 150);
  await trace.waitFor(2, 2000);
  expect(trace.handshakes.map((h) => h.t)).toEqual(['a', 'b']);
});
