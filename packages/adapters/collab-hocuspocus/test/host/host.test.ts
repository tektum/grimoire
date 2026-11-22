import { describe, expect, it, vi } from 'vitest';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { createCollabHost } from '../../src/host.js';
import { guardConnectHooks } from '../../src/guard.js';
import { makeDeps } from './support.js';

describe('Hocuspocus configuration', () => {
  it('debounce 3000 and maxDebounce 10000 by default, the configured values otherwise', async () => {
    const a = makeDeps('member');
    const host = createCollabHost();
    await host.start(a.deps);
    expect(host.hocuspocus?.configuration).toMatchObject({ debounce: 3000, maxDebounce: 10000 });
    await host.shutdown({ deadlineMs: 100 });

    const b = makeDeps('member');
    const base = makeFakeConfig();
    const deps = { ...b.deps, config: { ...base, collab: { ...base.collab, debounceMs: 111, maxDebounceMs: 222 } } };
    const host2 = createCollabHost();
    await host2.start(deps);
    expect(host2.hocuspocus?.configuration).toMatchObject({ debounce: 111, maxDebounce: 222 });
    await host2.shutdown({ deadlineMs: 100 });
  });

  it('shutdown with nothing loaded resolves at once with nothing abandoned', async () => {
    const host = createCollabHost();
    await host.start(makeDeps('member').deps);
    await expect(host.shutdown({ deadlineMs: 100 })).resolves.toEqual({ abandonedPages: 0 });
  });
});

describe('a failing upgrade is logged, not swallowed (S4)', () => {
  it('destroys the socket and logs collab.upgrade_failed with the error class only, once per 10 s with a held-back count', async () => {
    const t = makeDeps('member');
    const guard = { ...t.guard, checkUpgrade: () => Promise.reject(new RangeError('secret detail')) };
    const host = createCollabHost({ guard });
    await host.start(t.deps);
    const sockets = Array.from({ length: 3 }, () => ({ destroy: vi.fn(), destroyed: false, end: vi.fn() }));
    for (const socket of sockets) host.handleUpgrade({ url: '/collab', headers: {}, socket: {} } as never, socket as never, Buffer.alloc(0));
    await vi.waitFor(() => { expect(sockets.every((s) => s.destroy.mock.calls.length === 1)).toBe(true); });
    const logged = t.logger.entries.filter((e) => e.event === 'collab.upgrade_failed');
    expect(logged.map((e) => e.fields)).toEqual([{ errorName: 'RangeError', suppressed: 0 }]);
    expect(JSON.stringify(t.logger.entries)).not.toContain('secret detail');
    await host.shutdown({ deadlineMs: 100 });
  });
});

describe('an upgrade whose verdict arrives after shutdown began', () => {
  it('is refused with 503 and never reaches the WebSocket server', async () => {
    const t = makeDeps('member');
    let decide: (v: { ok: true; address: string; ticket: object }) => void = () => undefined;
    const verdict = new Promise<{ ok: true; address: string; ticket: object }>((resolve) => { decide = resolve; });
    const guard = { ...t.guard, checkUpgrade: () => verdict };
    const host = createCollabHost({ guard: guard as never });
    await host.start(t.deps);
    const socket = { destroy: vi.fn(), destroyed: false, end: vi.fn(), write: vi.fn(), once: vi.fn(), on: vi.fn() };
    host.handleUpgrade({ url: '/collab', headers: {}, socket: {} } as never, socket as never, Buffer.alloc(0));
    await host.shutdown({ deadlineMs: 100 });
    decide({ ok: true, address: '203.0.113.9', ticket: {} });
    await vi.waitFor(() => { expect(socket.end.mock.calls.length + socket.destroy.mock.calls.length).toBeGreaterThan(0); });
    expect(String(socket.end.mock.calls[0]?.[0])).toContain('503 Service Unavailable');
    expect(socket.write).not.toHaveBeenCalled(); // nothing was written as a WebSocket handshake
  });
});

describe('guardConnectHooks keeps the hooks a class defines on its prototype', () => {
  it('an extension that is a class instance still has onStoreDocument, with its own state, and its connect hook is still guarded', async () => {
    class Stored { stored: string[] = []; async onStoreDocument(data: { documentName: string }): Promise<void> { this.stored.push(data.documentName); } async onConnect(): Promise<void> { throw new Error('refuse'); } }
    const instance = new Stored();
    const t = makeDeps('member');
    const wrapped = guardConnectHooks(instance as never, t);
    await wrapped.onStoreDocument?.({ documentName: 'p' } as never);
    expect(instance.stored).toEqual(['p']);
    await expect(wrapped.onConnect?.({ context: {} } as never)).rejects.toBeDefined();
  });
});
