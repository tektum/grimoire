import { describe, expect, it } from 'vitest';
import { isDescopeProjectId } from '../../src/ports/auth-verifier.js';

describe('the identity provider project id rule', () => {
  it('accepts 1 to 128 letters and digits', () => {
    expect(isDescopeProjectId('P2testprojectidabcdefghijkl')).toBe(true);
    expect(isDescopeProjectId('a')).toBe(true);
    expect(isDescopeProjectId('a'.repeat(128))).toBe(true);
  });
  it.each(['', 'a'.repeat(129), 'P1-foo', 'P1_foo', 'P1 foo', 'P1é', 'P1\n'])('refuses %j', (value) => {
    expect(isDescopeProjectId(value)).toBe(false);
  });
});
