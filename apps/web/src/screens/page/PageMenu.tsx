import { Ellipsis } from 'lucide-react';
import type { Ref } from 'react';
import { Menu, type MenuItem } from '../../ui/primitives';

/**
 * The actions of a page that are not its text, in one menu on the page head: its history (for anyone who may read the page) and, for an administrator only, the reset of its saved
 * state (a repair, not an everyday action, so it is not a button on every page). The dialog of the reset is the page's: choosing the item only asks for it.
 */
export function PageMenu({ onHistory, onReset, triggerRef }: { onHistory: () => void; onReset?: (() => void) | undefined; triggerRef?: Ref<HTMLButtonElement> }) {
  const items: MenuItem[] = [{ label: 'History', onSelect: onHistory }];
  if (onReset !== undefined) items.push({ label: 'Reset saved state…', onSelect: onReset });
  return <Menu label="More page actions" icon={<Ellipsis aria-hidden size={16} strokeWidth={1.5} />} items={items} {...(triggerRef === undefined ? {} : { triggerRef })} />;
}
