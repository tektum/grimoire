import type { MiddlewareHandler } from 'hono';
import { errorResponse } from './error.js';

export interface BodyLimitOptions { readonly maxSize: number }

/**
 * Refuses a request body over `maxSize` bytes with 413 `too_large`. A declared content-length over the limit is refused without reading the body; any other body is
 * counted as it is read (a declared length is not trusted, a chunked body has none) and stops being read at the limit.
 *
 * Hono's own middleware rebuilds the request with `new Request(c.req.raw, ...)`, which throws under node-server with `overrideGlobalObjects: false` (the request
 * object is not a real Request): every body without a usable content-length answered 503. Here the request is rebuilt from its parts.
 */
export function bodyLimit(options: BodyLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.raw;
    if (raw.body === null || raw.body === undefined) return next();
    const declared = c.req.header('content-length');
    const chunked = c.req.header('transfer-encoding') !== undefined;
    if (declared !== undefined && !chunked && /^\d+$/.test(declared) && Number(declared) > options.maxSize) return errorResponse('too_large');
    const reader = raw.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > options.maxSize) {
        void reader.cancel().catch(() => undefined);
        return errorResponse('too_large');
      }
      parts.push(value);
    }
    const body = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { body.set(p, at); at += p.length; }
    const method = c.req.method;
    const bodiless = method === 'GET' || method === 'HEAD';
    c.req.raw = new Request(c.req.url, {
      method, headers: new Headers(c.req.header()), signal: raw.signal,
      ...(bodiless || size === 0 ? {} : { body }),
    });
    return next();
  };
}
