import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { deflateZeros } from './zip-builder.js';

// The bomb fixtures are built inside the tests, so the builder must be cheap (a hosted runner has 4 slow CPUs and a 5 s test timeout). The tests pin what it writes; its cost is measured in the PR, not asserted here.
describe('deflateZeros', () => {
  it.each([1, 2, 257, 258, 259, 2064, 2065, 2066, 4129, 10_000_000])('inflates to exactly %i zero bytes', (size) => {
    const out = inflateRawSync(deflateZeros(size));
    expect(out.length).toBe(size);
    expect(out.every((b) => b === 0)).toBe(true);
  });

  it('the 2 GiB bomb is about 13 MB of stream (the size, not the time: the cost is in the PR notes, a timing assertion would flake)', () => {
    const body = deflateZeros(2 * 1024 * 1024 * 1024);
    expect(body.length).toBeGreaterThan(13_000_000);
    expect(body.length).toBeLessThan(14_000_000);
  });
});
