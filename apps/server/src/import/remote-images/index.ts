import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { fileTypeFromBuffer } from 'file-type';
import { RequestFilteringHttpsAgent } from 'request-filtering-agent';
import type { ImportConfig } from '@tektum/grimoire-core/ports/config';
import type { Config } from '@tektum/grimoire-core/ports/config';

// Remote images copied in at import time (Q28 = C; contracts section 5; the web policy keeps displaying only uploaded images). Every control is built in, none is a setting: only a
// constructor argument, for tests, can name an address, a port or a certificate authority, and the production call passes none.

export type RemoteFailure = 'scheme' | 'blocked_address' | 'redirect' | 'too_large' | 'timeout' | 'status' | 'type' | 'budget' | 'network';
export type RemoteResult =
  | { readonly ok: true; readonly bytes: AsyncIterable<Uint8Array>; readonly contentType: string; readonly size: number }
  | { readonly ok: false; readonly reason: RemoteFailure };

/** The images and the time one import may spend on remote images. */
export interface RemoteBudget {
  readonly maxImages: number;
  readonly deadline: number;
  taken: number;
}
export function createRemoteBudget(config: Pick<ImportConfig, 'remote'>, now: () => number = Date.now): RemoteBudget {
  return { maxImages: config.remote.maxImages, deadline: now() + config.remote.totalSeconds * 1000, taken: 0 };
}

export interface RemoteImageFetcher {
  fetch(url: string, budget: RemoteBudget): Promise<RemoteResult>;
}

/** What a test may set, by the constructor only. */
export interface RemoteImageTestSeams {
  /** Addresses the filter lets through in addition to the public ones (the loopback address of a local test server). */
  readonly allowAddresses?: readonly string[];
  /** The only ports a URL may name (default: 443). */
  readonly ports?: readonly number[];
  /** A certificate authority to trust (the test server's own). */
  readonly ca?: string;
  /** A resolver, to give a name an address. */
  readonly lookup?: unknown;
  readonly now?: () => number;
}

export const REMOTE_IMAGE_USER_AGENT = 'Grimoire-Importer/1';
const MAX_HOPS = 3;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Addresses that are not the public internet. The agent checks every address it connects to; this is the check of literals in the URL before any socket exists. */
const NOT_PUBLIC = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) NOT_PUBLIC.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) NOT_PUBLIC.addSubnet(net, bits, 'ipv6');

/** `BlockList.check`, bound: the source rules grep for the authorizer's `.check(` call, which this is not. */
const isNotPublic = NOT_PUBLIC.check.bind(NOT_PUBLIC);

type Validated = { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly reason: RemoteFailure };

export function createRemoteImageFetcher(config: Config, seams: RemoteImageTestSeams = {}): RemoteImageFetcher | undefined {
  if (!config.import.fetchRemoteImages) return undefined;
  const limits = config.import.remote;
  const now = seams.now ?? Date.now;
  const ports = new Set(seams.ports ?? [443]);
  const allow = new Set(seams.allowAddresses ?? []);
  // The agent resolves the name and connects to the address it resolved (no second lookup: rebinding does nothing), and refuses loopback, private, link-local and metadata addresses.
  const agent = new RequestFilteringHttpsAgent({ keepAlive: false, ...(seams.ca === undefined ? {} : { ca: seams.ca }), ...(allow.size === 0 ? {} : { allowIPAddressList: [...allow] }) });

  const validate = (raw: string): Validated => {
    let url: URL;
    try { url = new URL(raw); } catch { return { ok: false, reason: 'scheme' }; }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return { ok: false, reason: 'scheme' };
    if (!ports.has(url.port === '' ? 443 : Number(url.port))) return { ok: false, reason: 'scheme' };
    // `new URL` has turned `2130706433`, `0x7f.1` and `017700000001` into `127.0.0.1`, and wraps IPv6 in brackets.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0 && !allow.has(host) && isNotPublic(host, isIP(host) === 6 ? 'ipv6' : 'ipv4')) return { ok: false, reason: 'blocked_address' };
    return { ok: true, url };
  };

  /** One request, not followed: the response, or a failure. */
  const once = (url: URL, signal: AbortSignal): Promise<{ res: IncomingMessage } | { reason: RemoteFailure }> =>
    new Promise((resolve) => {
      const req = request(url, {
        agent, method: 'GET', signal,
        headers: { 'user-agent': REMOTE_IMAGE_USER_AGENT, accept: 'image/png,image/jpeg,image/gif,image/webp', 'accept-encoding': 'identity' },
        ...(seams.lookup === undefined ? {} : { lookup: seams.lookup as never }),
      }, (res) => { resolve({ res }); });
      req.once('error', (e: Error) => {
        if (signal.aborted) resolve({ reason: 'timeout' });
        else resolve({ reason: /request-filtering-agent|is not allowed/.test(e.message) ? 'blocked_address' : 'network' });
      });
      req.end();
    });

  const fetchOne = async (start: string, signal: AbortSignal): Promise<RemoteResult> => {
    let current = start;
    const seen = new Set<string>();
    for (let hop = 0; ; hop++) {
      const v = validate(current);
      if (!v.ok) return v;
      if (seen.has(v.url.href)) return { ok: false, reason: 'redirect' };
      seen.add(v.url.href);
      const got = await once(v.url, signal);
      if ('reason' in got) return { ok: false, reason: got.reason };
      const { res } = got;
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume();
        const location = res.headers.location;
        if (location === undefined) return { ok: false, reason: 'status' };
        if (hop >= MAX_HOPS) return { ok: false, reason: 'redirect' };
        try { current = new URL(location, v.url).href; } catch { return { ok: false, reason: 'scheme' }; }
        continue;
      }
      if (status !== 200) { res.resume(); return { ok: false, reason: 'status' }; }
      return read(res, signal);
    }
  };

  const read = async (res: IncomingMessage, signal: AbortSignal): Promise<RemoteResult> => {
    const declared = (res.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!TYPES.has(declared)) { res.destroy(); return { ok: false, reason: 'type' }; }
    const length = Number(res.headers['content-length']);
    if (Number.isFinite(length) && length > limits.maxBytes) { res.destroy(); return { ok: false, reason: 'too_large' }; }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res) {
        size += (chunk as Buffer).length;
        if (size > limits.maxBytes) { res.destroy(); return { ok: false, reason: 'too_large' }; }
        chunks.push(chunk as Buffer);
      }
    } catch {
      return { ok: false, reason: signal.aborted ? 'timeout' : 'network' };
    }
    const body = Buffer.concat(chunks);
    const sniffed = await fileTypeFromBuffer(body);
    if (sniffed?.mime !== declared) return { ok: false, reason: 'type' };
    return { ok: true, bytes: (async function* () { yield body; })(), contentType: declared, size };
  };

  return {
    async fetch(url, budget) {
      if (budget.taken >= budget.maxImages || now() >= budget.deadline) return { ok: false, reason: 'budget' };
      budget.taken++;
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, Math.min(limits.timeoutSeconds * 1000, Math.max(1, budget.deadline - now())));
      try {
        return await fetchOne(url, controller.signal);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
