import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createPeerHooks } from '../../src/peer-bridge.js';
import { PeerRegistry } from '../../src/peers.js';
import { createUpgradeGuard } from '../../src/upgrade-guard.js';

describe('pong keeps a silent connection alive', () => {
  it('emitting pong on the peer websocket calls touch() on its ClientConnection', () => {
    const connection = { touch: vi.fn(), handleMessage: vi.fn(), handleClose: vi.fn() };
    const handleConnection = vi.fn(() => connection);
    const hooks = createPeerHooks({ hocuspocus: { handleConnection } as never, peers: new PeerRegistry({}), guard: createUpgradeGuard() });
    const websocket = new EventEmitter();
    const peer = { websocket, remoteAddress: '127.0.0.1', request: { url: '/collab', headers: new Headers() } };
    hooks.open?.(peer as never);
    expect(connection.touch).not.toHaveBeenCalled();
    websocket.emit('pong', Buffer.from('crossws-ping'));
    expect(connection.touch).toHaveBeenCalledTimes(1);
    expect(handleConnection).toHaveBeenCalledWith(websocket, expect.any(Request), expect.objectContaining({ address: '127.0.0.1', peerId: expect.any(String) }));
  });

  it('forwards messages and closes', () => {
    const connection = { touch: vi.fn(), handleMessage: vi.fn(), handleClose: vi.fn() };
    const hooks = createPeerHooks({ hocuspocus: { handleConnection: () => connection } as never, peers: new PeerRegistry({}), guard: createUpgradeGuard() });
    const peer = { websocket: new EventEmitter(), remoteAddress: undefined, request: { url: '/collab', headers: new Headers() } };
    hooks.open?.(peer as never);
    hooks.message?.(peer as never, { uint8Array: () => new Uint8Array([1]) } as never);
    hooks.close?.(peer as never, { code: 1006, reason: 'x' });
    expect(connection.handleMessage).toHaveBeenCalledWith(new Uint8Array([1]));
    expect(connection.handleClose).toHaveBeenCalledWith({ code: 1006, reason: 'x' });
  });
});
