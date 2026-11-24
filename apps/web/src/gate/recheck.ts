import type { ApiLike } from '../api/query';
import { CLIENT_VERSION } from '../version';
import { markClientOutdated } from './outdated';
import { isClientTooOld } from './version';

/**
 * The check of the minimum client version, once more: the gate made it at start, and the server may have been upgraded since. Called when a
 * collaboration reconnect succeeds after a long time offline. A server that says this client is too old (in the answer or as a 426) marks the client outdated,
 * and the app then shows the reload text and nothing else; a failure to ask changes nothing (the next long reconnect asks again).
 */
export async function recheckMinClientVersion(api: ApiLike, clientVersion: string = CLIENT_VERSION): Promise<void> {
  try {
    const { data, response } = await api.GET('/v1/config' as never, {} as never);
    if (response.status === 426) return void markClientOutdated();
    if (!response.ok) return;
    const min = (data as { minClientVersion?: unknown } | undefined)?.minClientVersion;
    if (typeof min === 'string' && isClientTooOld(min, clientVersion)) markClientOutdated();
  } catch {
    // the server could not be asked: nothing is known, nothing changes
  }
}
