// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/ui/global.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the styles in forced colours (high contrast)', () => {
  it('give the primary button the system colours: its accent and paper are not mapped by the browser, and a measurement of the page finds the paper on white', () => {
    const block = /@media \(forced-colors: active\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(block, 'a block for forced colours').not.toBeNull();
    const rule = /button\[data-variant='primary'\]\s*\{([^}]*)\}/.exec(block![1]!);
    expect(rule, 'a rule for the primary button').not.toBeNull();
    expect(rule![1]).toMatch(/background:\s*ButtonFace/);
    expect(rule![1]).toMatch(/color:\s*ButtonText/);
    expect(rule![1]).toMatch(/border:\s*2px solid ButtonText/);
  });
});
