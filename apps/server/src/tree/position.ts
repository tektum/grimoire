import { generateKeyBetween } from 'fractional-indexing';
import type { Ordering } from '@tektum/grimoire-core/tree/position';

/** Raised when the neighbours given to `between` are equal, reversed or not valid keys. */
export class InvalidNeighbours extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNeighbours';
  }
}

function isValid(key: string): boolean {
  if (!/^[0-9A-Za-z]+$/.test(key)) return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/** The server's ordering: fractional keys compared in byte order. */
export function createOrdering(): Ordering {
  return {
    between(before, after) {
      if (before !== null && after !== null && before >= after) {
        throw new InvalidNeighbours('neighbours must be strictly ascending');
      }
      try {
        return generateKeyBetween(before, after);
      } catch (cause) {
        throw new InvalidNeighbours((cause as Error).message);
      }
    },
    isValidPosition: isValid,
  };
}
