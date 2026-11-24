import type { BlockKind } from './blocks';

export const SLASH_MENU_ID = 'slash-menu';
export const slashOptionId = (kind: BlockKind): string => `slash-option-${kind.id}`;
export const optionId = (menu: string, kind: BlockKind): string => (menu === SLASH_MENU_ID ? slashOptionId(kind) : `${menu}-option-${kind.id}`);

/**
 * The list of block kinds under the cursor after a `/`. It is a listbox the editor points at (`aria-activedescendant` on the editing surface), because the focus stays in the
 * text: the keys are the editor's, the list only shows which item they would choose, and a click chooses one too. With `focused` the list takes the focus itself (the handle's
 * menu, opened from a button) and points at the item with its own `aria-activedescendant`: that attribute belongs on a listbox, not on a button.
 */
/** One function for every drawing: React calls a ref again when its function changes, and the list is to take the focus once, when it opens, not at each drawing. */
const takeFocus = (element: HTMLElement | null): void => element?.focus();

export function SlashMenu(props: { kinds: readonly BlockKind[]; active: number; onPick: (kind: BlockKind) => void; onHover: (index: number) => void; id?: string; label?: string; focused?: boolean }) {
  const menu = props.id ?? SLASH_MENU_ID;
  if (props.kinds.length === 0) {
    return (
      <p className="slash-empty" role="status">
        No block matches
      </p>
    );
  }
  return (
    <div
      id={menu}
      className="slash-list"
      role="listbox"
      aria-label={props.label ?? 'Turn this block into'}
      tabIndex={props.focused === true ? -1 : undefined}
      aria-activedescendant={props.focused === true && props.kinds[props.active] !== undefined ? optionId(menu, props.kinds[props.active] as BlockKind) : undefined}
      ref={props.focused === true ? takeFocus : undefined}
    >
      {props.kinds.map((kind, index) => (
        <div
          key={kind.id}
          id={optionId(menu, kind)}
          role="option"
          aria-selected={index === props.active}
          className="slash-option"
          tabIndex={-1}
          data-active={index === props.active ? 'true' : 'false'}
          // The mouse must not take the focus from the text: the choice is made on the press, not the release.
          onMouseDown={(event) => {
            event.preventDefault();
            props.onPick(kind);
          }}
          onMouseMove={() => props.onHover(index)}
        >
          <span className="slash-label">{kind.label}</span>
          <span className="slash-description">{kind.description}</span>
        </div>
      ))}
    </div>
  );
}
