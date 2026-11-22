import { afterEach, describe, expect, it, vi } from 'vitest';
import { PeerRegistry } from '../../src/peers.js';
import { REFUSAL_CLOSE_CODES } from '../../src/refusal.js';

const DOC_A = '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f10';
const DOC_B = '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f11';

function fakePeer() {
  const closes: { code: number; reason: string }[] = [];
  return { closes, peer: { close: (code: number, reason: string) => { closes.push({ code, reason }); }, terminate: vi.fn() } as never };
}

afterEach(() => { vi.useRealTimers(); });

describe('peer registry keeps users per document, not per socket', () => {
  it('one socket, two documents, two users: closing by the first user closes only the first user\'s document and leaves the socket', () => {
    const peers = new PeerRegistry(REFUSAL_CLOSE_CODES);
    const s = fakePeer();
    peers.add('p1', s.peer);
    peers.markAuthenticated('p1', 'u1', DOC_A);
    peers.markAuthenticated('p1', 'u2', DOC_B); // the last document to authenticate used to overwrite the user of the whole socket
    const closed: string[] = [];
    peers.closeUser('u1', (peerId, documentName) => { closed.push(`${peerId}:${documentName}`); });
    expect(closed).toEqual([`p1:${DOC_A}`]);
    expect(s.closes).toEqual([]);
  });

  it('closing by the second user matches too (the old registry matched only the last)', () => {
    const peers = new PeerRegistry(REFUSAL_CLOSE_CODES);
    const s = fakePeer();
    peers.add('p1', s.peer);
    peers.markAuthenticated('p1', 'u1', DOC_A);
    peers.markAuthenticated('p1', 'u2', DOC_B);
    const closed: string[] = [];
    peers.closeUser('u2', (_p, d) => { closed.push(d); });
    expect(closed).toEqual([DOC_B]);
  });

  it('a socket whose every document belongs to the user is closed; another socket of the same user is closed too; a third user\'s socket is not', () => {
    vi.useFakeTimers();
    const peers = new PeerRegistry(REFUSAL_CLOSE_CODES);
    const a = fakePeer(); const b = fakePeer(); const c = fakePeer();
    peers.add('p1', a.peer); peers.add('p2', b.peer); peers.add('p3', c.peer);
    peers.markAuthenticated('p1', 'u1', DOC_A);
    peers.markAuthenticated('p2', 'u1', DOC_A); peers.markAuthenticated('p2', 'u1', DOC_B);
    peers.markAuthenticated('p3', 'u3', DOC_A);
    const closed: string[] = [];
    peers.closeUser('u1', (p, d) => { closed.push(`${p}:${d}`); });
    expect(closed.sort()).toEqual([`p1:${DOC_A}`, `p2:${DOC_A}`, `p2:${DOC_B}`]);
    expect(a.closes).toHaveLength(1);
    expect(b.closes).toHaveLength(1);
    expect(c.closes).toEqual([]);
  });

  it('a released document no longer belongs to its user', () => {
    const peers = new PeerRegistry(REFUSAL_CLOSE_CODES);
    const s = fakePeer();
    peers.add('p1', s.peer);
    peers.markAuthenticated('p1', 'u1', DOC_A);
    peers.releaseDocument('p1', DOC_A);
    const closed: string[] = [];
    peers.closeUser('u1', (_p, d) => { closed.push(d); });
    expect(closed).toEqual([]);
  });
});
