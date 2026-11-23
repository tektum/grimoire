/** Server-to-client WebSocket frames (RFC 6455 section 5): unmasked, FIN-bearing, with 7-bit, 16-bit or 64-bit lengths. */
export interface CloseSeen { readonly code: number; readonly reason: string }

/** Walks the frames in `buf` in order and returns the first close frame, or undefined when none is complete yet (a partial frame waits for more bytes). */
export function firstCloseFrame(buf: Buffer): CloseSeen | undefined {
  let at = 0;
  while (buf.length - at >= 2) {
    const opcode = (buf[at] ?? 0) & 0x0f;
    let len = (buf[at + 1] ?? 0) & 0x7f;
    let header = 2;
    if (len === 126) { if (buf.length - at < 4) return undefined; len = buf.readUInt16BE(at + 2); header = 4; }
    else if (len === 127) { if (buf.length - at < 10) return undefined; len = Number(buf.readBigUInt64BE(at + 2)); header = 10; }
    if (buf.length - at < header + len) return undefined;
    if (opcode === 0x8) {
      const body = buf.subarray(at + header, at + header + len);
      return body.length >= 2 ? { code: body.readUInt16BE(0), reason: body.subarray(2).toString() } : { code: 1005, reason: '' };
    }
    at += header + len; // a ping, pong or data frame before the close: skip it
  }
  return undefined;
}
