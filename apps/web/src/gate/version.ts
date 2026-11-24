import { compareVersions, parseVersion } from '@tektum/grimoire-core/version';

/**
 * Whether this client is older than the server's minimum. A version that is not a plain `1.2.3` triple is read as "not too old" on the server's side
 * (the server validates its own setting) and as "too old" on the client's side: an unreadable client version cannot claim to be current.
 */
export function isClientTooOld(minClientVersion: string, clientVersion: string): boolean {
  const min = parseVersion(minClientVersion);
  if (min === null) return false;
  const client = parseVersion(clientVersion);
  if (client === null) return true;
  return compareVersions(client, min) < 0;
}
