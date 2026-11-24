import { messageFor } from '../api/messages';
import type { TreeActions } from './actions';
import type { FlatPage } from './model';
import { planDrop } from './moves';

/**
 * What a drop of one page does: the move the API is asked for, or a notice (`say`) when the drop is into the page itself or below it (nothing is sent: the
 * server would refuse it as `would_create_cycle`, with the same words).
 */
export function dropPage(pages: readonly FlatPage[], actions: TreeActions, say: (text: string) => void, drop: { dragId: string; parentId: string | null; index: number }): void {
  const plan = planDrop(pages, drop.dragId, drop.parentId, drop.index);
  if (plan === 'cycle') say(messageFor('would_create_cycle'));
  else void actions.move(drop.dragId, plan);
}
