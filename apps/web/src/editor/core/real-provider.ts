import { HocuspocusProvider, HocuspocusProviderWebsocket, type onAuthenticationFailedParameters, type onCloseParameters, type onStatelessParameters } from '@hocuspocus/provider';
import { FRAGMENT_NAME } from '@tektum/grimoire-editor-schema';
import * as Y from 'yjs';
import type { ProviderEvent, ProviderHandle, Session } from './connection';

export interface LiveSession extends Session {
  readonly ydoc: Y.Doc;
  readonly awareness: NonNullable<HocuspocusProvider['awareness']>;
}

/**
 * A new document and a provider for one page, not yet connected. The provider's own reconnecting is off (one attempt per
 * `connect()`): every attempt after a failure is the connection manager's. `token` is the handshake token function.
 */
export function createLiveSession(options: { url: string; pageId: string; token: () => Promise<string> }): LiveSession {
  const ydoc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({ url: options.url, autoConnect: false, maxAttempts: 1 });
  const provider = new HocuspocusProvider({ name: options.pageId, document: ydoc, token: options.token, websocketProvider: socket });
  provider.attach();
  const listeners = new Set<(event: ProviderEvent) => void>();
  const emit = (event: ProviderEvent): void => listeners.forEach((listener) => listener(event));
  provider.on('status', ({ status }: { status: string }) => {
    if (status === 'connecting' || status === 'connected' || status === 'disconnected') emit({ type: 'status', status });
  });
  provider.on('authenticated', ({ scope }: { scope: string }) => emit({ type: 'authenticated', scope: scope === 'readonly' ? 'readonly' : 'read-write' }));
  provider.on('synced', () => emit({ type: 'synced' }));
  provider.on('authenticationFailed', ({ reason }: onAuthenticationFailedParameters) => emit({ type: 'authenticationFailed', reason }));
  provider.on('close', ({ event }: onCloseParameters) => emit({ type: 'close', code: event.code, ...(event.reason === '' ? {} : { reason: event.reason }) }));
  provider.on('stateless', ({ payload }: onStatelessParameters) => emit({ type: 'stateless', payload }));
  const handle: ProviderHandle = {
    connect: () => void socket.connect(),
    disconnect: () => socket.disconnect(),
    destroy: () => {
      provider.destroy();
      socket.destroy();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const awareness = provider.awareness;
  if (awareness === null) throw new Error('the provider has no awareness');
  return { provider: handle, ydoc, awareness, doc: { isEmpty: () => ydoc.getXmlFragment(FRAGMENT_NAME).length === 0, destroy: () => ydoc.destroy() } };
}
