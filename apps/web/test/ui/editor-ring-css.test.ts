// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/screens/page/page.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the focus ring of the editor', () => {
  it('is drawn with the focus token, only when the focus came by Tab and the browser says it is a focus to show, and the plain look stays for the rest', () => {
    const rule = /\[data-input='keyboard'\]\s+\.page-editor\s+\.ProseMirror:focus-visible\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'a rule for the ring').not.toBeNull();
    expect(rule![1]).toMatch(/outline:\s*2px solid var\(--focus\)/);
    expect(rule![1]).toMatch(/outline-offset:\s*8px/);
    expect(css).toMatch(/\.page-editor\s+\.ProseMirror\s*\{\s*outline:\s*none/);
  });
});
