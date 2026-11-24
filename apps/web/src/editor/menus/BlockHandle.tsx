import { GripVertical } from 'lucide-react';
import type { BlockKind } from './blocks';
import { SlashMenu } from './SlashMenu';

export const HANDLE_MENU_ID = 'block-handle-menu';

/**
 * The handle at the left of the block the pointer is over: a button that opens the list of block kinds for that block. (The block is not dragged: moving a block is a
 * change of structure, which the editor does not offer yet.) The menu is the slash menu's list, so one component and one way of choosing.
 */
export function BlockHandle(props: { open: boolean; kinds: readonly BlockKind[]; active: number; onToggle: () => void; onPick: (kind: BlockKind) => void; onHover: (index: number) => void }) {
  return (
    <>
      <button
        type="button"
        className="block-handle-button"
        aria-label="Block menu"
        aria-haspopup="listbox"
        aria-expanded={props.open}
        aria-controls={props.open ? HANDLE_MENU_ID : undefined}
        onClick={props.onToggle}
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
      {props.open ? (
        <div className="block-handle-menu">
          <SlashMenu kinds={props.kinds} active={props.active} onPick={props.onPick} onHover={props.onHover} id={HANDLE_MENU_ID} label="Turn this block into" />
        </div>
      ) : null}
    </>
  );
}
