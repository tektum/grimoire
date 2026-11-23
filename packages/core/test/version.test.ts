import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion } from '../src/version.js';

describe('parseVersion', () => {
  it.each([
    ['0.0.0', [0, 0, 0]],
    ['1.2.3', [1, 2, 3]],
    ['10.20.30', [10, 20, 30]],
  ])('reads %s', (text, triple) => {
    expect(parseVersion(text)).toEqual(triple);
  });

  it.each(['', '1', '1.2', '1.2.3.4', 'a.b.c', '1.2.x', '1..3', '-1.2.3', '1.2.3-beta', ' 1.2.3', '1.2.3 ', '01.2.3', '1.2.99999999999999999999'])(
    'refuses %j',
    (text) => {
      expect(parseVersion(text)).toBeNull();
    },
  );
});

describe('compareVersions', () => {
  it('compares each part as a number, not as text', () => {
    expect(compareVersions([1, 10, 0], [1, 9, 0])).toBe(1);
    expect(compareVersions([1, 9, 0], [1, 10, 0])).toBe(-1);
    expect(compareVersions([2, 0, 0], [10, 0, 0])).toBe(-1);
  });

  it('lets an earlier part win over a later one', () => {
    expect(compareVersions([2, 0, 0], [1, 99, 99])).toBe(1);
    expect(compareVersions([1, 2, 3], [1, 3, 0])).toBe(-1);
    expect(compareVersions([1, 2, 4], [1, 2, 3])).toBe(1);
  });

  it('answers 0 for equal triples', () => {
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0);
  });
});
