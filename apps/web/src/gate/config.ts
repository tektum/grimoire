import type { components } from '@tektum/grimoire-api-client';
import { CLIENT_VERSION } from '../version';
import { GATE_RETRY_MS } from './messages';
import { isClientOutdated } from './outdated';
import { isClientTooOld } from './version';

export type ServerConfig = components['schemas']['ClientConfig'];

export type GateState = { kind: 'loading' } | { kind: 'unreachable' } | { kind: 'not-ready' } | { kind: 'outdated' } | { kind: 'ready'; config: ServerConfig };

export interface GateOptions {
  readonly apiUrl: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly clientVersion?: string;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isConfig(value: unknown): value is ServerConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  // Both nullable fields must be present: a missing providerProjectId is not "no project", it is an answer this client does not understand.
  const nullableText = (key: string) => key in v && (v[key] === null || typeof v[key] === 'string');
  return typeof v['collabUrl'] === 'string' && typeof v['minClientVersion'] === 'string' && typeof v['local'] === 'boolean' && nullableText('providerProjectId') && nullableText('fileStoreOrigin');
}

/**
 * Reads `GET /v1/config` (public: no token, no cookie) until the server answers. A network failure or any answer other than 200 reports its state and tries
 * again every 5 s; 503 is "not ready", anything else unreachable. When it answers, a minimum client version above this client's is `outdated` and nothing
 * else follows. Every state is reported through `onState`; the final one (`ready` or `outdated`) is also the result. A stop through `signal` ends the loop.
 */
export async function loadServerConfig(options: GateOptions, onState: (state: GateState) => void = () => {}): Promise<GateState> {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const sleep = options.sleep ?? wait;
  const clientVersion = options.clientVersion ?? CLIENT_VERSION;
  const report = (state: GateState): GateState => {
    onState(state);
    return state;
  };
  for (;;) {
    if (options.signal?.aborted) return { kind: 'loading' };
    // A client already told it is too old sends nothing more, this request included.
    if (isClientOutdated()) return report({ kind: 'outdated' });
    let failure: GateState | null = null;
    try {
      const response = await doFetch(`${options.apiUrl}/v1/config`, {
        credentials: 'omit',
        headers: { 'X-Grimoire-Client-Version': clientVersion },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (response.status === 200) {
        const body: unknown = await response.json();
        if (isConfig(body)) return report(isClientTooOld(body.minClientVersion, clientVersion) ? { kind: 'outdated' } : { kind: 'ready', config: body });
        failure = { kind: 'unreachable' };
      } else if (response.status === 426) {
        return report({ kind: 'outdated' });
      } else {
        failure = response.status === 503 ? { kind: 'not-ready' } : { kind: 'unreachable' };
      }
    } catch {
      if (options.signal?.aborted) return { kind: 'loading' };
      failure = { kind: 'unreachable' };
    }
    report(failure);
    await sleep(GATE_RETRY_MS);
  }
}
