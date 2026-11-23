// The real run() of dist/main.js plus test routes: one slow, several that fail, one slow stream.
import { setTimeout as sleep } from 'node:timers/promises';
import { HTTPException } from 'hono/http-exception';
import { fail } from '../../../dist/http/error.js';
import { run } from '../../../dist/lifecycle/run.js';

await run({
  routes: (app) => {
    app.get('/slow', async (c) => {
      process.stdout.write(`${JSON.stringify({ event: 'test.slow_entered' })}\n`); // the test waits for this line instead of guessing when the request arrived
      // Fixture, not a wait: a deliberately slow handler, so a request is still in flight when the test sends SIGTERM.
      await sleep(1500);
      return c.text('finished');
    });
    app.get('/boom/throw', () => { throw new Error('sync password=hunter2'); });
    app.get('/boom/reject', async () => { await sleep(1); throw new TypeError('async password=hunter2'); });
    app.get('/boom/value', () => { throw 'string password=hunter2'; });
    app.get('/boom/http', () => { throw new HTTPException(418, { message: 'teapot password=hunter2' }); });
    app.get('/boom/refused', () => fail('forbidden')); // an error raised on purpose: answers 403 and logs http.handler_rejected
    app.get('/stream', () => {
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('first'));
          // Fixture, not a wait: the stream fails a while after its first chunk, so a client can abort mid-response.
          await sleep(500);
          controller.error(new Error('stream failed password=hunter2'));
        },
      });
      return new Response(body);
    });
  },
});
