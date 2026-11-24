import type { BlockKind } from './blocks';

export const SLASH_MENU_ID = 'slash-menu';
export const slashOptionId = (kind: BlockKind): string => `slash-option-${kind.id}`;

/**
 * The list of block kinds under the cursor after a `/`. It is a listbox the editor points at (`aria-activedescendant` on the editing surface), because the focus stays in the
 * text: the keys are the editor's, the list only shows which item they would choose, and a click chooses one too.
 */
export function SlashMenu(props: { kinds: readonly BlockKind[]; active: number; onPick: (kind: BlockKind) => void; onHover: (index: number) => void }) {
  if (props.kinds.length === 0) {
    return (
      <p className="slash-empty" role="status">
        No block matches
      </p>
    );
  }
  return (
    <div id={SLASH_MENU_ID} className="slash-list" role="listbox" aria-label="Turn this block into">
      {props.kinds.map((kind, index) => (
        <div
          key={kind.id}
          id={slashOptionId(kind)}
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
