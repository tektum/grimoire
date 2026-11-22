import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { startCollab } from '../../src/collab/index.js';
import { createEventLog } from '../../src/events.js';
import { Shutdown } from '../../src/lifecycle/shutdown.js';

function fixture(config = makeFakeConfig()) {
  const shutdown = new Shutdown(new FakeClock(0));
  const host = { start: vi.fn(() => Promise.resolve()), handleUpgrade: vi.fn(), closeConnections: vi.fn(() => Promise.resolve()), shutdown: vi.fn(() => Promise.resolve({ abandonedPages: 0 })) };
  const log = createEventLog(new FakeLogger());
  const server = createServer();
  return { shutdown, host, log, server, config, deps: { config, log, host, hostDeps: {} as never, server, shutdown } };
}

describe('a signal while the collaboration host starts (S8)', () => {
  it('does not throw "shutdown has started": the started host is shut down and nothing is registered', async () => {
    const f = fixture();
    f.host.start.mockImplementation(async () => { void f.shutdown.run(f.log, 'SIGTERM'); });
    await expect(startCollab(f.deps)).resolves.toEqual([]);
    expect(f.host.shutdown).toHaveBeenCalledOnce();
    expect(f.server.listenerCount('upgrade')).toBe(0);
  });

  it('a failure to listen on the second port shuts the already started host down before the error propagates', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => { blocker.listen(0, '127.0.0.1', r); });
    const port = (blocker.address() as { port: number }).port;
    const f = fixture(makeFakeConfig({ collabPort: port, host: '127.0.0.1' }));
    await expect(startCollab(f.deps)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(f.host.shutdown).toHaveBeenCalledOnce();
    await new Promise<void>((r) => { blocker.close(() => { r(); }); });
  });
});
