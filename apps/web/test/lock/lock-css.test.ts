// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/editor/lock/lock.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the styles of the lock message', () => {
  it('use the design tokens only: no colour of their own', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgba?|hsla?)\(/);
    const colours = [...css.matchAll(/(?:color|background|border-color|border|border-inline-start|outline):[^;]*;/g)].map((m) => m[0]);
    expect(colours.length).toBeGreaterThan(0);
    for (const line of colours) expect(line).toMatch(/var\(--[a-z0-9-]+\)|transparent|none|solid/);
  });

  it('keep the message out of sight until it is shown', () => {
    expect(css).toMatch(/\.lock-notice-host:not\(\[data-show='true'\]\)\s*\{\s*display:\s*none/);
  });
});
