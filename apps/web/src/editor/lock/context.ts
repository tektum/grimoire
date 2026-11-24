import { $ctx } from '@milkdown/utils';
import type { Directory } from '../core/directory';

/** What the lock needs from the open page: the awareness the editor publishes through (and reads the others from), who the signed-in person is, and the names. */
export interface LockContext {
  readonly awareness: {
    readonly clientID: number;
    getStates(): Map<number, Record<string, unknown>>;
    setLocalStateField(field: string, value: unknown): void;
  };
  readonly userId: () => string | null;
  readonly directory: Directory;
}

/** Set by the screen's mount when it binds the page; null where there is no page (the saved view, a test with no connection): then nothing is locked. */
export const lockContext = $ctx<LockContext | null, 'grimoireLockContext'>(null, 'grimoireLockContext');
