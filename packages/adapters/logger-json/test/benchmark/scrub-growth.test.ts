import { describe, expect, it } from 'vitest';
import { redactString } from '../../src/scrub.js';

/**
 * CPU time of the log scrubber on adversarial text (same method as the converter benchmark in markdown-milkdown: `process.cpuUsage`,
 * so a loaded machine does not fail it, and a growth ratio rather than a wall-clock limit). Input of 250 KB and of 1 MB is scrubbed;
 * linear work grows 4-fold, a quadratic pass 16-fold; the limit is 8. The scrubber caps its input, so the work is in fact flat:
 * this test fails the day a pass runs over the input before the cap, or the cap stops bounding a pass. It does not prove that the passes
 * behind the cap are linear: the capped input is at most 2,048 characters, so a quadratic pass over it would still be fast and unseen here.
 */
const MAX_GROWTH = 8;
const REPEAT = 20;
const cpu = (): number => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const measure = (input: string): number => {
  redactString(input); // warm up
  const before = cpu();
  for (let i = 0; i < REPEAT; i += 1) redactString(input);
  return Math.max(cpu() - before, 1);
};
const shapes: Array<[string, (n: number) => string]> = [
  ['spaces then colons', (n) => `${' '.repeat(n / 2)}${':'.repeat(n / 2)}`],
  ['equals signs separated by spaces', (n) => ' ='.repeat(n / 2)],
  ['unclosed quoted secrets', (n) => 'password="'.repeat(n / 10)],
  ['backslashes in a quoted secret', (n) => `password="${'\\'.repeat(n)}`],
  ['userinfo markers', (n) => `://${'@'.repeat(n)}`],
  ['bearer followed by spaces', (n) => `bearer${' '.repeat(n)}`],
  ['eyJ runs', (n) => 'eyJ.'.repeat(n / 4)],
  ['question marks', (n) => '?'.repeat(n)],
  ['a long run without whitespace', (n) => 'a'.repeat(n)],
];

describe('scrubber CPU time grows no faster than about linearly', () => {
  it.each(shapes)('%s', (_name, make) => {
    const small = measure(make(250_000));
    const large = measure(make(1_000_000));
    expect(large / small, `250 KB: ${small} ms, 1 MB: ${large} ms`).toBeLessThan(MAX_GROWTH);
  });
});
