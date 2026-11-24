import { describe, expect, it } from 'vitest';
import { verdictOf } from '../../src/screens/page/latest';

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
