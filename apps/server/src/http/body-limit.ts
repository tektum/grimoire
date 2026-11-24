import type { MiddlewareHandler } from 'hono';
import { errorResponse } from './error.js';

export interface BodyLimitOptions { readonly maxSize: number }

/**
 * Refuses a request body over `maxSize` bytes with 413 `too_large`. A declared content-length over the limit is refused without reading the body, and one within it passes
 * on unbuffered; a body with no usable length (chunked) is counted as it is read and stops being read at the limit.
 *
 * Hono's own middleware rebuilds the request with `new Request(c.req.raw, ...)`, which throws under node-server with `overrideGlobalObjects: false` (the request
 * object is not a real Request): every body without a usable content-length answered 503. Here the request is rebuilt from its parts.
 */
export function bodyLimit(options: BodyLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.raw;
    if (raw.body === null) return next();
    const declared = c.req.header('content-length');
    const chunked = c.req.header('transfer-encoding') !== undefined;
    if (declared !== undefined && !chunked && /^\d+$/.test(declared)) {
      // A valid declared length is the length the server reads (the HTTP parser stops there): over the limit is refused unread, within it passes on untouched and unbuffered.
      return Number(declared) > options.maxSize ? errorResponse('too_large') : next();
    }
    // No usable length (chunked): counted as read, in memory up to the limit only.
    const reader = raw.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > options.maxSize) {
          void reader.cancel();
          return errorResponse('too_large');
        }
        parts.push(value);
      }
    } catch {
      return errorResponse('invalid'); // the client went away mid-body: nobody reads the answer
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
