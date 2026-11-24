import { describe, expect, it } from 'vitest';
import { latestOnly } from '../../src/screens/page/latest';

describe('only the latest of several calls in flight', () => {
  it('is the latest until another begins', () => {
    const begin = latestOnly();
    const first = begin();
    expect(first()).toBe(true);
    const second = begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('is decided by the order they began in, not the order they finish in (the older one finishing last is not the latest)', () => {
    const begin = latestOnly();
    const older = begin();
    const newer = begin();
    const finished: string[] = [];
    if (newer()) finished.push('newer applies');
    if (older()) finished.push('older applies');
    expect(finished).toEqual(['newer applies']);
  });

  it('keeps separate counters for separate owners', () => {
    const a = latestOnly();
    const b = latestOnly();
    const fromA = a();
    b();
    b();
    expect(fromA()).toBe(true);
  });
});
