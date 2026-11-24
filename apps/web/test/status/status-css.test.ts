import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('the action beside the status text', () => {
  const css = readFileSync(resolve(process.cwd(), 'apps/web/src/status/status.css'), 'utf8');
  it('keeps a token gap from the message (no raw length)', () => {
    expect(css).toMatch(/\.page-status-action\s*\{[^}]*margin-inline-start:\s*var\(--space-2\)/);
  });
});
