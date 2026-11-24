import { HocuspocusProvider } from '@hocuspocus/provider';
import type { HocuspocusProviderConfiguration, HocuspocusProviderWebsocketConfiguration } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { originSocket } from './e2e.ts';

export const ALLOWED_ORIGIN = 'http://127.0.0.1:8080';
export { originSocket };
/** The configuration of a provider that connects with `WebSocketPolyfill`: the option reaches the socket the provider makes, but the provider's configuration type does not list it (it is the socket's option). */
export const originProviderConfig = (config: HocuspocusProviderConfiguration & { WebSocketPolyfill?: unknown }): HocuspocusProviderConfiguration => config;
export interface Client {
  readonly provider: HocuspocusProvider;
  readonly document: Y.Doc;
  readonly text: Y.Text;
  readonly failures: string[];
  readonly closes: number[];
  destroy(): void;
}
export interface ConnectOptions {
  readonly origin?: string;
  readonly onStateless?: (payload: string) => void;
  readonly maxAttempts?: number;
  readonly refusal?: (error: ConnectionRefused) => void;
  readonly onAuthentication?: () => void;
}
export class ConnectionRefused extends Error { constructor() { super('collaboration connection refused'); this.name = 'ConnectionRefused'; } }
type ProviderOptions = Omit<HocuspocusProviderConfiguration, 'url'> & HocuspocusProviderWebsocketConfiguration;

export function connect(url: string | { readonly url: string }, name: string, token: string | (() => string) = 'dev:test-secret-0123456789abcdef:alice:member', options: ConnectOptions = {}): Client {
  const failures: string[] = [];
  const closes: number[] = [];
  const document = new Y.Doc();
  const socket: HocuspocusProviderWebsocketConfiguration = {
    url: typeof url === 'string' ? url : url.url,
    WebSocketPolyfill: originSocket(options.origin ?? ALLOWED_ORIGIN),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    onMaxAttemptsFailed: () => { options.refusal?.(new ConnectionRefused()); },
  };
  const config: ProviderOptions = {
    ...socket,
    name,
    token,
    document,
    onStateless: ({ payload }) => { options.onStateless?.(payload); },
    onAuthenticated: () => { options.onAuthentication?.(); },
    onAuthenticationFailed: ({ reason }) => { failures.push(reason); },
    onClose: ({ event }) => { closes.push(event.code); },
  };
  const provider = new HocuspocusProvider(config);
  return {
    provider,
    document,
    get text() { return document.getText('prosemirror'); },
    failures,
    closes,
    destroy: () => { provider.destroy(); },
  };
}
