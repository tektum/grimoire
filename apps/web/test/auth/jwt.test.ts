import { describe, expect, it } from 'vitest';
import { jwtExpiresAt } from '../../src/auth/jwt';

const part = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

describe('jwtExpiresAt', () => {
  it('reads exp, in seconds, as milliseconds', () => {
    expect(jwtExpiresAt(`${part({ alg: 'none' })}.${part({ exp: 1_800_000_000 })}.sig`)).toBe(1_800_000_000_000);
  });
  it('reads a payload in the URL-safe alphabet with its padding left out', () => {
    // A payload whose base64 form has - and _ characters and a length that is not a multiple of 4.
    const payload = { exp: 1_800_000_000, name: '??>>~~' };
    expect(part(payload)).toMatch(/[-_]/);
    expect(jwtExpiresAt(`h.${part(payload)}.s`)).toBe(1_800_000_000_000);
  });
  it.each([['no dots'], ['a.b'], ['a..c'], ['a.!!!.c'], [`a.${part({ exp: 'soon' })}.c`], [`a.${part({})}.c`], [`a.${part({ exp: null })}.c`], [`a.${btoa('not json')}.c`], ['']])(
    'gives null for %j',
    (token) => {
      expect(jwtExpiresAt(token)).toBeNull();
    },
  );
});
