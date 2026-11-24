import type { Page } from '@playwright/test';

/**
 * The probe: connects to the real collaboration server with a socket of its own, from a page of the app (so the server sees the app's origin), and
 * records what the server says for each refusal: the permission-denied reason, then the close code and reason.
 */
export interface Observed {
  readonly denied: string | null;
  readonly close: { readonly code: number; readonly reason: string } | null;
  /** Set when a frame from the server could not be read (it ends inside a number or a string). */
  readonly malformed?: true;
}

export async function probe(page: Page, options: { collabUrl: string; documentName: string; handshake: string; stopAtRefusal?: boolean }): Promise<Observed> {
  return page.evaluate(async ({ collabUrl, documentName, handshake, stopAtRefusal }) => {
    const uint = (out: number[], value: number) => {
      let n = value;
      while (n > 127) {
        out.push(128 | (n & 127));
        n = Math.floor(n / 128);
      }
      out.push(n);
    };
    const string = (out: number[], text: string) => {
      const data = new TextEncoder().encode(text);
      uint(out, data.length);
      out.push(...data);
    };
    const auth: number[] = [];
    string(auth, documentName);
    uint(auth, 2); // authentication
    uint(auth, 0); // a token
    string(auth, handshake);
    const readUint = (bytes: Uint8Array, at: { i: number }) => {
      let result = 0;
      let shift = 1;
      for (;;) {
        if (at.i >= bytes.length) throw new Error('the frame ends inside a number');
        const byte = bytes[at.i++]!;
        result += (byte & 127) * shift;
        if (byte < 128) return result;
        shift *= 128;
      }
    };
    const readString = (bytes: Uint8Array, at: { i: number }) => {
      const length = readUint(bytes, at);
      if (at.i + length > bytes.length) throw new Error('the frame ends inside a string');
      const text = new TextDecoder().decode(bytes.slice(at.i, at.i + length));
      at.i += length;
      return text;
    };
    return await new Promise<{ denied: string | null; close: { code: number; reason: string } | null; malformed?: true }>((resolve) => {
      const seen: { denied: string | null; close: { code: number; reason: string } | null; malformed?: true } = { denied: null, close: null };
      const socket = new WebSocket(collabUrl);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => socket.send(new Uint8Array(auth));
      socket.onmessage = (event) => {
        try {
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          const at = { i: 0 };
          readString(bytes, at);
          if (readUint(bytes, at) === 2 && readUint(bytes, at) === 1) {
            seen.denied = readString(bytes, at); // permission denied, with its reason
            if (stopAtRefusal === true) resolve(seen); // a server that does not close after a refusal (a scripted one) is not waited on
          }
        } catch {
          seen.malformed = true; // a frame the probe cannot read is reported, not waited on
        }
      };
      socket.onclose = (event) => {
        seen.close = { code: event.code, reason: event.reason };
        resolve(seen); // the server closes the socket after a refusal: that ends the probe
      };
    });
  }, options);
}

export const token = (session: string, extra: Record<string, unknown> = {}) => `g1.${Buffer.from(JSON.stringify({ t: session, v: '0.0.0', ...extra })).toString('base64url')}`;
