import { describe, expect, it } from 'vitest';
import { firstCloseFrame } from '../../test-e2e/m3/ws-frames.ts';

const close = (code: number, reason: string): Buffer => Buffer.concat([Buffer.from([0x88, 2 + reason.length, code >> 8, code & 255]), Buffer.from(reason)]);
const ping = Buffer.from([0x89, 0x00]);

describe('the M3 raw client reads the close frame wherever it sits', () => {
  it('a close frame alone', () => { expect(firstCloseFrame(close(4408, 'preauth-timeout'))).toEqual({ code: 4408, reason: 'preauth-timeout' }); });
  it('a close frame after a ping (the old parser needed byte 0 to be 0x88)', () => { expect(firstCloseFrame(Buffer.concat([ping, close(4408, 'preauth-timeout')]))).toEqual({ code: 4408, reason: 'preauth-timeout' }); });
  it('a close frame arriving in two pieces is found once complete', () => {
    const f = close(4408, 'preauth-timeout');
    expect(firstCloseFrame(f.subarray(0, 3))).toBeUndefined();
    expect(firstCloseFrame(f)).toEqual({ code: 4408, reason: 'preauth-timeout' });
  });
  it('a 16-bit-length data frame before the close is skipped', () => {
    const data = Buffer.concat([Buffer.from([0x82, 126, 0x01, 0x00]), Buffer.alloc(256)]);
    expect(firstCloseFrame(Buffer.concat([data, close(4408, 'x')]))).toEqual({ code: 4408, reason: 'x' });
  });
});
