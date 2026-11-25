import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { deflateZeros } from './zip-builder.js';

// The bomb fixtures are built inside the tests, so the builder must be cheap: a hosted runner has 4 slow CPUs and a 5 s test timeout.
describe('deflateZeros', () => {
  it.each([1, 2, 257, 258, 259, 2064, 2065, 2066, 4129, 10_000_000])('inflates to exactly %i zero bytes', (size) => {
    const out = inflateRawSync(deflateZeros(size));
    expect(out.length).toBe(size);
    expect(out.every((b) => b === 0)).toBe(true);
  });

  it('builds the 2 GiB bomb in a fraction of a second (it deflated every 258 bytes one bit at a time before)', () => {
    const t = Date.now();
    const body = deflateZeros(2 * 1024 * 1024 * 1024);
    expect(Date.now() - t).toBeLessThan(150);
    expect(body.length).toBeGreaterThan(13_000_000);
    expect(body.length).toBeLessThan(14_000_000);
  });
});
