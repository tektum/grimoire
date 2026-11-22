import { describe, expect, it } from 'vitest';
import { resolveLimits } from '../../src/limits.js';
import { resolveOptions } from '../../src/pool.js';

describe('pool options: each is a positive integer and an error names it', () => {
  const names = ['poolSize', 'timeoutMs', 'seedTimeoutMs', 'reseedTimeoutMs', 'heapMb', 'queueLimit', 'closeDeadlineMs'] as const;
  it.each(names)('%s', (name) => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => resolveOptions({ [name]: bad }), `${name} ${bad}`).toThrow(`${name} must be a positive integer`);
    expect(resolveOptions({ [name]: 7 })[name]).toBe(7);
  });
  it.each(['timeoutMs', 'seedTimeoutMs', 'reseedTimeoutMs'] as const)('%s is at most 4294967295', (name) => {
    expect(() => resolveOptions({ [name]: 4_294_967_296 })).toThrow(`${name} must be at most 4294967295`);
    expect(resolveOptions({ [name]: 4_294_967_295 })[name]).toBe(4_294_967_295);
  });
  it('defaults', () => {
    expect(resolveOptions()).toMatchObject({ poolSize: 2, timeoutMs: 10_000, seedTimeoutMs: 5_000, reseedTimeoutMs: 30_000, heapMb: 512, queueLimit: 32, closeDeadlineMs: 5_000 });
  });
});

describe('limits', () => {
  it.each(['maxStateBytes', 'maxDepth', 'maxBlocks', 'maxSeedMarkdownBytes', 'maxSeedLines', 'maxSeedLineMarkers', 'maxReseedMarkdownBytes', 'maxReseedLineMarkers'] as const)('%s must be a positive integer', (name) => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => resolveLimits({ [name]: bad }), `${name} ${bad}`).toThrow(`${name} must be a positive integer`);
    expect(resolveLimits({ [name]: 3 })[name]).toBe(3);
    expect(resolveLimits({ [name]: 1 })[name]).toBe(1);
    expect(resolveLimits({ [name]: undefined })[name]).toBe(resolveLimits(undefined)[name]);
  });
  it('verifyRoundTrip', () => {
    expect(resolveLimits({ verifyRoundTrip: false }).verifyRoundTrip).toBe(false);
    expect(resolveLimits({}).verifyRoundTrip).toBe(true);
  });
});
