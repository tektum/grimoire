import { BlockList, isIP } from 'node:net';

// The one place the client address of a request or an upgrade is decided, shared by the HTTP limiters and the collaboration upgrade
// guard, so a fix to proxy trust or address parsing reaches both.

/** What a request without a usable peer address counts under. */
export const UNKNOWN_ADDRESS = 'unknown';
/** The longest text taken for an address (45 characters for IPv6 with an IPv4 tail, plus a short zone id, with room for padding). */
const MAX_ADDRESS_TEXT = 100;

/**
 * One canonical text per client: lower-case compressed IPv6 (WHATWG URL does the parsing), IPv4-mapped IPv6 shown as IPv4.
 * Returns undefined for anything that is not an IP address.
 */
export function normaliseAddress(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length > MAX_ADDRESS_TEXT) return undefined; // bounded before any work: an address text is at most 45 characters, plus a zone id
  const trimmed = raw.trim();
  const zone = trimmed.indexOf('%'); // a zone id (fe80::1%eth0) does not identify another client
  const text = zone < 0 ? trimmed : trimmed.slice(0, zone);
  const family = isIP(text);
  if (family === 4) return text;
  if (family !== 6) return undefined;
  let host: string;
  try { host = new URL(`http://[${text}]`).hostname.slice(1, -1); } catch { return undefined; }
  // URL turns ::ffff:1.2.3.4 into ::ffff:102:304; convert back so both spellings are one client.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped?.[1] === undefined || mapped[2] === undefined) return host;
  const hi = parseInt(mapped[1], 16);
  const lo = parseInt(mapped[2], 16);
  return `${String(hi >> 8)}.${String(hi & 255)}.${String(lo >> 8)}.${String(lo & 255)}`;
}

/** Trusted-proxy ranges as a `BlockList`; each entry is an IP or `ip/prefix`. */
export function buildTrustedProxies(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [ip, prefix] = entry.split('/');
    const address = normaliseAddress(ip);
    if (address === undefined) continue; // the config validated the entry; a stray one trusts nothing
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    // An IPv4-mapped IPv6 CIDR is the same range as its IPv4 form (prefix counts 96 more bits).
    const bits = prefix === undefined ? undefined : Number(prefix) - (isIP(ip ?? '') === 6 && family === 'ipv4' ? 96 : 0);
    if (bits === undefined) list.addAddress(address, family);
    else if (Number.isInteger(bits) && bits >= 0) list.addSubnet(address, bits, family);
  }
  return list;
}

const isTrusted = (list: BlockList, address: string): boolean => list.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');

/**
 * The client address: the socket's peer address, unless that peer is a trusted proxy. Then `X-Forwarded-For` is read from the
 * right and the first entry that is not itself a trusted proxy is the client (the left-most value is client-supplied and never
 * used blindly). A malformed entry ends the walk and the peer address stays the client.
 */
export function resolveClientAddress(forwarded: string | null, peer: string | undefined, trusted: BlockList): string {
  const direct = normaliseAddress(peer);
  if (direct === undefined) return UNKNOWN_ADDRESS;
  if (forwarded === null || !isTrusted(trusted, direct)) return direct;
  const entries = forwarded.split(',').map((e) => normaliseAddress(e));
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry === undefined) return direct;
    if (!isTrusted(trusted, entry)) return entry;
  }
  return entries[0] ?? direct;
}

/**
 * The key an address is throttled, banned and capped under: an IPv6 address is its /64 (one subscriber holds a whole /64 and can
 * rotate inside it at will), an IPv4 address is itself. Expects the canonical text of `normaliseAddress`.
 */
export function addressKey(address: string): string {
  if (isIP(address) !== 6) return address;
  // Hand-written: `net` has no prefix masking. The canonical form has no leading zeros and at most one `::`.
  const [head = '', tail] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = tail === undefined ? left : [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right];
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/**
 * A `X-Forwarded-For` value as some proxies write it: `[2001:db8::5]:443` and `203.0.113.7:5678` lose their port and brackets. Entries
 * that are not of those forms are left as they are (and `resolveClientAddress` then treats them as malformed).
 */
export function forwardedWithoutPorts(forwarded: string): string {
  return forwarded
    .split(',')
    .map((entry) => {
      const text = entry.trim();
      const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(text);
      if (bracketed?.[1] !== undefined) return bracketed[1];
      return /^[^:]+:\d+$/.test(text) ? text.slice(0, text.indexOf(':')) : text;
    })
    .join(',');
}
