import type { Ordering } from '../tree/position.js';

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; // in byte order

/** A key strictly between `a` and `b` (null: no upper end), by choosing digits one place at a time. */
function middle(a: string, b: string | null): string {
  if (b !== null) {
    let shared = 0;
    while (shared < a.length && a[shared] === b[shared]) shared += 1;
    if (shared > 0) return b.slice(0, shared) + middle(a.slice(shared), b.slice(shared));
  }
  if (a === '' && b !== null && b[0] === '0') {
    // Nothing is below a lone "0"; below "0" followed by zeros the key "0" itself fits; otherwise keep the leading "0" and go below the rest.
    if (/^0+$/.test(b)) return b.length > 1 ? '0' : '0V'; // "0V" is above "0": the caller's check refuses it
    return '0' + middle('', b.slice(1));
  }
  const low = a === '' ? 0 : DIGITS.indexOf(a[0] as string);
  const high = b === null ? DIGITS.length : DIGITS.indexOf(b[0] as string);
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)] as string;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return (DIGITS[low] as string) + middle(a.slice(1), null);
}

/** In-memory ordering for tests: keys of ASCII letters and digits that stay strictly ordered however they are inserted. */
export class FakeOrdering implements Ordering {
  between(before: string | null, after: string | null): string {
    const low = before ?? '';
    if (after !== null && !(low < after)) throw new RangeError('the neighbours are not in order');
    const key = middle(low, after);
    if (!(key > low) || (after !== null && !(key < after))) throw new RangeError('no key fits between the neighbours');
    return key;
  }

  isValidPosition(key: string): boolean {
    return /^[0-9A-Za-z]+$/.test(key);
  }
}
