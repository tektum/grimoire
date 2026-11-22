import { describe, expect, it } from 'vitest';
import { sanitise } from '../../src/index.js';

/**
 * Contracts section 4, step 7: saved Markdown and text never contain U+0000 (PostgreSQL text columns reject it; a
 * documented PostgreSQL behaviour, and not something the conversion facts file states) and are valid UTF-16.
 */
describe('sanitise', () => {
  it('replaces every NUL with U+FFFD', () => {
    expect(sanitise('a\u0000b\u0000\u0000c')).toBe('a\uFFFDb\uFFFD\uFFFDc');
  });

  it('replaces a lone high or low surrogate and keeps a valid pair', () => {
    expect(sanitise('x\uD800y')).toBe('x\uFFFDy');
    expect(sanitise('x\uDC00y')).toBe('x\uFFFDy');
    expect(sanitise('x\uD83D\uDE00y')).toBe('x\u{1F600}y');
    expect(sanitise('\uD83D')).toBe('\uFFFD');
  });

  it('leaves other control and bidi characters unchanged', () => {
    const value = 'a\u0001\u202E\u2028b';
    expect(sanitise(value)).toBe(value);
  });
});
