import { BlockList, isIP } from 'node:net';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

// The adapter packages are built only in composition (R2.18), so these rules are written out here as the collaboration upgrade guard
// has them: one canonical text per client, IPv6 counted by its /64, the forwarded header read from the right.
const UNKNOWN = 'unknown';
const MAX_ADDRESS_TEXT = 100;

/** One canonical text per client: lower-case compressed IPv6, IPv4-mapped IPv6 shown as IPv4, a zone id dropped. Undefined for anything that is not an IP address. */
function normaliseAddress(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length > MAX_ADDRESS_TEXT) return undefined;
  const trimmed = raw.trim();
  const zone = trimmed.indexOf('%');
  const text = zone < 0 ? trimmed : trimmed.slice(0, zone);
  const family = isIP(text);
  if (family === 4) return text;
  if (family !== 6) return undefined;
  const host = new URL(`http://[${text}]`).hostname.slice(1, -1); // `isIP` has accepted the text, so the URL parser cannot refuse it
  // URL turns ::ffff:1.2.3.4 into ::ffff:102:304; convert back so both spellings are one client.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped?.[1] === undefined || mapped[2] === undefined) return host;
  const hi = parseInt(mapped[1], 16);
  const lo = parseInt(mapped[2], 16);
  return `${String(hi >> 8)}.${String(hi & 255)}.${String(lo >> 8)}.${String(lo & 255)}`;
}

/** The key a client counts under: an IPv6 address is its /64 (a subscriber holds a whole block and can rotate inside it), an IPv4 address is itself. */
function addressKey(address: string): string {
  if (isIP(address) !== 6) return address;
  // `net` has no prefix masking. The canonical form has no leading zeros and at most one `::`.
  const [head = '', tail] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = tail === undefined ? left : [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right];
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** Trusted-proxy ranges from `config.trustedProxies` (an IP or `ip/prefix` each; the configuration has validated them). */
export function trustedProxyList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [ip = '', prefix] = entry.split('/');
    const address = normaliseAddress(ip);
    if (address === undefined) continue;
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    // An IPv4-mapped IPv6 range is the same range as its IPv4 form, and its prefix counts 96 more bits.
    const bits = prefix === undefined ? undefined : Number(prefix) - (isIP(ip) === 6 && family === 'ipv4' ? 96 : 0);
    if (bits === undefined) list.addAddress(address, family);
    else if (Number.isInteger(bits) && bits >= 0) list.addSubnet(address, bits, family);
  }
  return list;
}

const isTrusted = (list: BlockList, address: string): boolean => list.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');

function peerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined; // no socket (a request made in process)
  }
}

/** A forwarded entry as the proxy wrote it: `[2001:db8::5]:443` and `203.0.113.7:5678` lose the port, brackets go. */
function withoutPort(entry: string): string | undefined {
  const text = entry.trim();
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(text);
  if (bracketed?.[1] !== undefined) return normaliseAddress(bracketed[1]);
  return normaliseAddress(/^[^:]+:\d+$/.test(text) ? text.slice(0, text.indexOf(':')) : text);
}

/**
 * The key a request counts under. The address is the socket peer, unless the peer is a trusted proxy: then `X-Forwarded-For` is read
 * from the right and the first entry that is not itself a trusted proxy is the client. A malformed entry, or a chain of trusted
 * proxies only, leaves the peer. The left-most value is client-supplied and never trusted on its own.
 */
export function clientAddress(c: Context, trusted: BlockList): string {
  const peer = normaliseAddress(peerAddress(c));
  if (peer === undefined) return UNKNOWN;
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded === undefined || !isTrusted(trusted, peer)) return addressKey(peer);
  const entries = forwarded.split(',').map(withoutPort);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry === undefined) return addressKey(peer);
    if (!isTrusted(trusted, entry)) return addressKey(entry);
  }
  return addressKey(peer);
}
