// A stand-in worker for the failure tests: the Markdown of a `seed` call names what to do (the real worker is not touched).
// The stack at the moment this module was evaluated: it names `require` when a worker loaded the module through require(esm).
const loadStack = new Error().stack ?? '';

export default async function behave(request) {
  const command = request.op === 'seed' ? request.markdown : 'echo';
  switch (command) {
    case 'load-stack':
      return { ok: true, state: new TextEncoder().encode(loadStack) };
    case 'spin': {
      // Busy loop: nothing but terminating the thread stops it.
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        /* spin */
      }
      return { ok: true, state: new Uint8Array(1) };
    }
    case 'stamp': {
      // Busy for 400 ms and report when it started and ended (wall clock, shared by every thread): two calls overlap exactly when their intervals do.
      const start = Date.now();
      while (Date.now() < start + 400) {
        /* spin */
      }
      return { ok: true, state: new Uint8Array(new Float64Array([start, Date.now()]).buffer) };
    }
    case 'busy-300': {
      const end = Date.now() + 300;
      while (Date.now() < end) {
        /* spin */
      }
      return { ok: true, state: new Uint8Array(1) };
    }
    case 'busy-50': {
      const end = Date.now() + 50;
      while (Date.now() < end) {
        /* spin */
      }
      return { ok: true, state: new Uint8Array(1) };
    }
    case 'alloc': {
      const keep = [];
      for (;;) keep.push(new Array(100_000).fill(keep.length));
    }
    case 'throw':
      throw new Error('PAGE TEXT SECRET');
    case 'exit':
      process.exit(3);
      return undefined;
    case 'async-throw':
      setTimeout(() => {
        throw new Error('PAGE TEXT SECRET');
      }, 0);
      // Fixture, not a wait: keeps the job unanswered so the uncaught error above takes the worker down before any reply.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return { ok: true, state: new Uint8Array(1) };
    case 'bad-reply':
      return 42;
    default:
      return { ok: true, state: new Uint8Array([1, 2, 3]) };
  }
}
