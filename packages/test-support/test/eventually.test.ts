import { describe, expect, it } from 'vitest';
import { eventually } from '../src/e2e.ts';

describe('eventually: a condition holds on a value that is not undefined, null or false', () => {
  it.each([[undefined], [null], [false]])('keeps waiting on %s and times out', async (v) => {
    await expect(eventually(() => v, 60, 'never')).rejects.toThrow('timed out: never');
  });

  it.each([[0], [''], [true], ['x'], [{}]])('returns %j at once (a real answer)', async (v) => {
    expect(await eventually(() => v, 1000, 'now')).toBe(v);
  });

  it('polls until the value appears', async () => {
    let n = 0;
    expect(await eventually(() => (++n >= 3 ? 'ok' : null), 2000, 'third try')).toBe('ok');
  });
});
