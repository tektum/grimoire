import { describe, expect, it } from 'vitest';
import { OrderingNotAvailable } from '@tektum/grimoire-core/tree/position';
import { createOrdering } from '../src/tree/position.js';

describe('the server ordering skeleton', () => {
  it('refuses both operations with OrderingNotAvailable until the real ordering is composed', () => {
    const ordering = createOrdering();
    expect(() => ordering.between(null, null)).toThrow(OrderingNotAvailable);
    expect(() => ordering.isValidPosition('a0')).toThrow(OrderingNotAvailable);
  });
});
