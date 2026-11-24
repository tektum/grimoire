import type { LockContext } from './context';

/** The id of another person whose cursor is in the block, or null. (The same person in another tab is not "another person": they can see their own cursor.) */
export function holderOf(context: LockContext, blockId: string): string | null {
  const me = context.userId();
  for (const [clientId, state] of context.awareness.getStates()) {
    if (clientId === context.awareness.clientID || state['blockId'] !== blockId) continue;
    const user = state['user'];
    const id = typeof user === 'object' && user !== null && 'id' in user && typeof user.id === 'string' ? user.id : null;
    if (id !== null && id !== me) return id;
  }
  return null;
}
