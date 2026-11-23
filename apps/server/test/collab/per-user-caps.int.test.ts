import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, startServer } from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { RawClient } from './limits-support.js';
import { eventually, newPage, originSocket, seedPage, wsUrl, ALLOWED_ORIGIN } from './support.js';

const DB = `grimoire_m3t01b_caps_${String(process.pid)}`;
const pages = Array.from({ length: 4 }, newPage);
/** The limit a refusal logged (`user-documents` or `user-sockets`): both refuse with the same close frame, only the log tells them apart. */
const limitHits = (s: ServerProcess, limit: string) => s.events.filter((e) => e['event'] === 'collab.limit_hit' && e['limit'] === limit);
const token = (user: string) => `dev:test-secret-0123456789abcdef:${user}:member`;

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); for (const page of pages) await seedPage(DB, page); }, 60_000);
afterAll(() => dropTestDatabase(DB));

describe('per-user caps', () => {
  it('the document cap alone: 3 documents on one socket, a fourth on a second socket is refused full-for-you for the document cap, not the socket cap; second user stays, close frees', async () => {
    const server = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_COLLAB_MAX_DOCUMENTS_PER_USER: '3', GRIMOIRE_COLLAB_MAX_SOCKETS_PER_USER: '50' } });
    try {
      const shared = new HocuspocusProviderWebsocket({ url: wsUrl(server.port), WebSocketPolyfill: originSocket(ALLOWED_ORIGIN) });
      const docs: HocuspocusProvider[] = [];
      for (const page of pages.slice(0, 3)) {
        const c = new HocuspocusProvider({ websocketProvider: shared, document: new Y.Doc(), name: page, token: token('alice') });
        docs.push(c); c.attach(); await eventually(() => c.isAuthenticated ? true : undefined, 3000, 'shared document authentication');
      }
      const fourth = await RawClient.open(wsUrl(server.port), pages[3] as string, token('alice'));
      const other = await RawClient.open(wsUrl(server.port), pages[3] as string, token('bob'));
      await eventually(() => fourth.closed, 3000, 'full-for-you');
      expect(fourth.closed).toMatchObject({ code: 4503, reason: 'full-for-you' });
      expect(other.closed).toBeUndefined();
      await eventually(() => (limitHits(server, 'user-documents').length > 0 ? true : undefined), 3000, 'user-documents limit logged');
      expect(limitHits(server, 'user-sockets')).toEqual([]);
      for (const c of docs) c.destroy(); shared.destroy(); fourth.close(); other.close();
      const recovered = await RawClient.open(wsUrl(server.port), pages[3] as string, token('alice'));
      expect(recovered.closed).toBeUndefined(); recovered.close();
    } finally { await server.kill(); }
  }, 30_000);

  it('the socket cap alone: with room for many documents, a second socket of the same user is refused full-for-you and another user is not', async () => {
    const server = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_COLLAB_MAX_DOCUMENTS_PER_USER: '50', GRIMOIRE_COLLAB_MAX_SOCKETS_PER_USER: '1' } });
    try {
      const first = await RawClient.open(wsUrl(server.port), pages[0] as string, token('carol'));
      await eventually(() => (first.frames.length > 0 ? true : undefined), 5000, 'the first socket is admitted');
      const second = await RawClient.open(wsUrl(server.port), pages[1] as string, token('carol'));
      const other = await RawClient.open(wsUrl(server.port), pages[1] as string, token('dave'));
      await eventually(() => second.closed, 5000, 'the second socket of the same user is refused');
      expect(second.closed).toMatchObject({ code: 4503, reason: 'full-for-you' });
      await eventually(() => (limitHits(server, 'user-sockets').length > 0 ? true : undefined), 3000, 'user-sockets limit logged');
      expect(limitHits(server, 'user-documents')).toEqual([]);
      expect(other.closed).toBeUndefined();
      expect(first.closed).toBeUndefined();
      first.close(); second.close(); other.close();
    } finally { await server.kill(); }
  }, 30_000);

  it('two sessions on one document and one socket count as two, and a third document is refused', async () => {
    const server = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_COLLAB_MAX_DOCUMENTS_PER_USER: '2', GRIMOIRE_COLLAB_MAX_SOCKETS_PER_USER: '3' } });
    try {
      const shared = new HocuspocusProviderWebsocket({ url: wsUrl(server.port), WebSocketPolyfill: originSocket(ALLOWED_ORIGIN) });
      const sessions = [0, 1].map(() => new HocuspocusProvider({ websocketProvider: shared, document: new Y.Doc(), name: pages[0] as string, token: token('alice'), sessionAwareness: true }));
      for (const s of sessions) { s.attach(); await eventually(() => s.isAuthenticated ? true : undefined, 3000, 'session authenticated'); }
      const other = await RawClient.open(wsUrl(server.port), pages[1] as string, token('bob'));
      expect(other.closed).toBeUndefined();
      const over = await RawClient.open(wsUrl(server.port), pages[2] as string, token('alice'));
      await eventually(() => over.closed, 3000, 'two sessions over the per-user document cap');
      expect(over.closed).toMatchObject({ code: 4503, reason: 'full-for-you' });
      await eventually(() => (limitHits(server, 'user-documents').length > 0 ? true : undefined), 3000, 'user-documents limit logged');
      expect(limitHits(server, 'user-sockets')).toEqual([]);
      expect(other.closed).toBeUndefined();
      for (const s of sessions) s.destroy();
      shared.destroy(); other.close();
    } finally { await server.kill(); }
  }, 30_000);
});
