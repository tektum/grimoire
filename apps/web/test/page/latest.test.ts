import { describe, expect, it } from 'vitest';
import { latestOnly, verdictOf } from '../../src/screens/page/latest';

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

describe('what a finished rename means for the page', () => {
  it('is applied when it was answered with success and is still the latest', () => {
    expect(verdictOf(() => true, true)).toBe('applied');
  });
  it('is a refusal only when it was the latest: a failure of an older one says nothing about the title now', () => {
    expect(verdictOf(() => true, false)).toBe('refused');
    expect(verdictOf(() => false, false)).toBe('superseded');
  });
  it('is superseded, success or not, when a later one began', () => {
    expect(verdictOf(() => false, true)).toBe('superseded');
  });
});
