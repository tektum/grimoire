import type { BlockList } from 'node:net';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { addressKey, buildTrustedProxies, forwardedWithoutPorts, resolveClientAddress } from '@tektum/grimoire-core/users/client-address';

/** Trusted-proxy ranges from `config.trustedProxies` (an IP or `ip/prefix` each), parsed as the collaboration upgrade guard parses them. */
export const trustedProxyList = (entries: readonly string[]): BlockList => buildTrustedProxies(entries);

function peerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined; // no socket (a request made in process)
  }
}

/**
 * The key a request counts under: the client address by the rules shared with the collaboration upgrade guard (the socket peer unless it
 * is a trusted proxy, then `X-Forwarded-For` from the right; ports stripped), and an IPv6 client by its /64.
 */
export function clientAddress(c: Context, trusted: BlockList): string {
  const forwarded = c.req.header('x-forwarded-for');
  return addressKey(resolveClientAddress(forwarded === undefined ? null : forwardedWithoutPorts(forwarded), peerAddress(c), trusted));
}
