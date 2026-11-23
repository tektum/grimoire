import type { Ordering } from '../tree/position.js';

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; // in byte order

/** A key strictly between `a` and `b` (null: no upper end), by choosing digits one place at a time. */
function middle(a: string, b: string | null): string {
  if (b !== null) {
    let shared = 0;
    while ((a[shared] ?? '0') === b[shared]) shared += 1;
    if (shared > 0) return b.slice(0, shared) + middle(a.slice(shared), b.slice(shared));
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
