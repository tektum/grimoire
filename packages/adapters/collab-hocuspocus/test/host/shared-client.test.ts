import { expect, it, vi } from 'vitest';
import { startLive } from './live-support.js';
import { connect, ConnectionRefused } from '@tektum/grimoire-test-support';

it('returns an authenticated provider, closes cleanly, and reports a refused connection by name', async () => {
  const live = await startLive('member');
  const page = '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f10';
  live.t.pages.seed(page);
  const clients: { destroy(): void }[] = [];
  try {
    const client = connect(live.url, page, 't');
    clients.push(client);
    await vi.waitFor(() => { expect(client.provider.isAuthenticated, client.failures.join(', ')).toBe(true); });
    expect(client.provider.authorizedScope).toBe('read-write');
    expect(client.failures).toEqual([]);
    client.destroy();
    expect(client.provider.isAttached).toBe(false);
    await expect(new Promise<Error>((resolve) => {
      clients.push(connect('ws://127.0.0.1:1/collab', 'refused', 't', { maxAttempts: 1, refusal: resolve }));
    })).resolves.toBeInstanceOf(ConnectionRefused);
  } finally {
    for (const client of clients) client.destroy();
    await live.stop();
  }
});
