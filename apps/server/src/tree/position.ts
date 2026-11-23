import type { Ordering } from '@tektum/grimoire-core/tree/position';
import { unavailableOrdering } from '@tektum/grimoire-core/tree/position';

/** The server's ordering. A skeleton: until the ordering task lands, both functions throw `OrderingNotAvailable`. */
export function createOrdering(): Ordering {
  return unavailableOrdering;
}
