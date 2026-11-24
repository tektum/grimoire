import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Ctx, MilkdownPlugin } from '@milkdown/ctx';
import { SlashProvider, slashFactory } from '@milkdown/plugin-slash';
import { TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { BLOCK_KINDS, matchingKinds, type BlockKind } from './blocks';
import { SLASH_MENU_ID, SlashMenu, slashOptionId } from './SlashMenu';

const slash = slashFactory('grimoire-slash');

/** What the person has typed after a `/` that starts the paragraph the cursor is in, or null when the cursor is not in such a paragraph. */
export function slashQuery(view: EditorView): string | null {
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty || !view.editable) return null;
  const { $from } = selection;
  if ($from.parent.type.name !== 'paragraph') return null;
  const typed = $from.parent.textBetween(0, $from.parentOffset, undefined, '\uFFFC');
  const match = /^\/([^\s/]*)$/.exec(typed);
  return match === null ? null : (match[1] ?? '');
}

/** Replaces the `/query` text of the paragraph by the block kind: the text goes first (a command acts on the block as it is), and comes back if the schema refuses the kind. */
function choose(ctx: Ctx, view: EditorView, kind: BlockKind): void {
  const { $from } = view.state.selection;
  const from = $from.start();
  const typed = view.state.doc.textBetween(from, $from.pos);
  view.dispatch(view.state.tr.delete(from, $from.pos));
  if (!kind.run(ctx)) view.dispatch(view.state.tr.insertText(typed, from));
  view.focus();
}

function createView(ctx: Ctx, view: EditorView) {
  const host = document.createElement('div');
  host.className = 'slash-host';
  // A press on the list (its scroll bar, the space between items) must not take the focus from the text. (The items are focusable without being tab stops, so the scrolling list has keyboard access.)
  host.addEventListener('mousedown', (event) => event.preventDefault());
  const root = createRoot(host);
  const provider = new SlashProvider({ content: host, debounce: 0, offset: 6, shouldShow: (v) => slashQuery(v) !== null && state.dismissedAt !== v.state.selection.from });
  const state = { kinds: BLOCK_KINDS, active: 0, dismissedAt: -1, open: false };

  const render = (): void => {
    root.render(
      createElement(SlashMenu, {
        kinds: state.kinds,
        active: state.active,
        onPick: (kind) => choose(ctx, view, kind),
        onHover: (index) => {
          state.active = index;
          render();
        },
      }),
    );
    const surface = view.dom;
    if (state.open && state.kinds[state.active] !== undefined) {
      surface.setAttribute('aria-controls', SLASH_MENU_ID);
      surface.setAttribute('aria-activedescendant', slashOptionId(state.kinds[state.active] as BlockKind));
    } else {
      surface.removeAttribute('aria-controls');
      surface.removeAttribute('aria-activedescendant');
    }
  };
  provider.onShow = () => {
    state.open = true;
    render();
  };
  provider.onHide = () => {
    state.open = false;
    render();
  };

  const spec = {
    update(next: EditorView, prev?: Parameters<typeof provider.update>[1]) {
      const query = slashQuery(next);
      const kinds = query === null ? BLOCK_KINDS : matchingKinds(query);
      if (kinds.length !== state.kinds.length || kinds.some((kind, i) => kind !== state.kinds[i])) state.active = 0;
      state.kinds = kinds;
      provider.update(next, prev);
    },
    destroy() {
      provider.destroy();
      root.unmount();
      host.remove();
      view.dom.removeAttribute('aria-controls');
      view.dom.removeAttribute('aria-activedescendant');
    },
  };

  /** The keys of an open menu. */
  const key = (event: KeyboardEvent): boolean => {
    if (!state.open || slashQuery(view) === null) return false;
    const count = state.kinds.length;
    if (event.key === 'Escape') {
      state.dismissedAt = view.state.selection.from;
      provider.hide();
      return true;
    }
    if (count === 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      state.active = (state.active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
      render();
      host.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      choose(ctx, view, state.kinds[state.active] as BlockKind);
      return true;
    }
    return false;
  };
  return { spec, key };
}

/** The menu of block kinds that opens on `/` at the start of a paragraph: arrows move, Enter or Tab chooses, Escape closes, typing narrows the list. */
const configure: MilkdownPlugin = (ctx) => () => {
  let current: ReturnType<typeof createView> | null = null;
  ctx.set(slash.key, {
    view: (view) => {
      current = createView(ctx, view);
      return current.spec;
    },
    props: { handleKeyDown: (_view, event) => current?.key(event) ?? false },
  });
};

export const slashMenu: MilkdownPlugin[] = [slash[0], configure, slash[1]];
