import { CLIENT_VERSION } from '../version';
import { isClientOutdated, markClientOutdated } from './outdated';
import { isClientTooOld } from './version';

/**
 * The check of the minimum client version, once more: the gate made it at start, and the server may have been upgraded since. Called when a
 * collaboration reconnect succeeds after a long time offline. A server that says this client is too old (in the answer or as a 426) marks the client outdated,
 * and the app then shows the reload text and nothing else. A failure to ask changes nothing, and says nothing: the page is live, and the next long reconnect asks
 * again. It is the gate's own plain request (no retries, no notices of the API client, which would show a toast for a probe nobody asked for).
 */
export async function recheckMinClientVersion(options: { readonly apiUrl: string; readonly fetch?: typeof fetch; readonly clientVersion?: string }): Promise<void> {
  if (isClientOutdated()) return;
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const clientVersion = options.clientVersion ?? CLIENT_VERSION;
  try {
    const response = await doFetch(`${options.apiUrl}/v1/config`, { credentials: 'omit', headers: { 'X-Grimoire-Client-Version': clientVersion } });
    if (response.status === 426) return void markClientOutdated();
    if (response.status !== 200) return;
    const min = ((await response.json()) as { minClientVersion?: unknown } | null)?.minClientVersion;
    if (typeof min === 'string' && isClientTooOld(min, clientVersion)) markClientOutdated();
  } catch {
    // the server could not be asked: nothing is known, nothing changes
  }
}
