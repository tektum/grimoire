import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { MenuItem } from '../ui/primitives';

/**
 * The menu of one row: the shared menu look (`menu`, `menu-item`), with a trigger that is in the tab order only while its row has the focus. The tree is one stop;
 * inside it the focused row's buttons come next, and the arrow keys move between rows (a menu button on every row in the tab order would be a stop per page).
 */
/** What happens in the menu belongs to the menu: React lets events of a portal bubble through the row to the tree, whose own key and focus handling would move its focus while the menu is being used. */
const keep = (e: { stopPropagation: () => void }): void => { e.stopPropagation(); };

export function RowMenu({ label, items, tabIndex }: { label: string; items: readonly MenuItem[]; tabIndex: 0 | -1 }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="tree-menu" aria-label={label} tabIndex={tabIndex} onKeyDown={keep}>
          …
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end" onKeyDown={keep} onFocus={keep} onBlur={keep}>
          {items.map((item) => (
            <DropdownMenu.Item key={item.label} className="menu-item" onSelect={item.onSelect}>
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
