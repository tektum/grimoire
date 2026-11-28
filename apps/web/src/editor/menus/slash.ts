import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Ctx, MilkdownPlugin } from '@milkdown/ctx';
import { SlashProvider, slashFactory } from '@milkdown/plugin-slash';
import { TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { allowBlockChange } from '../lock';
import { matchingKinds, SLASH_KINDS, type BlockKind } from './blocks';
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
  // Refused by the lock, or by the schema: the text the person typed is put back.
  if (!allowBlockChange(ctx, kind, from) || !kind.run(ctx)) view.dispatch(view.state.tr.insertText(typed, from));
  view.focus();
}

/** The smallest room the menu keeps for itself, however close to the bottom the line is: a couple of rows, scrolled. */
const MIN_ROOM_PX = 96;
/** The distance between the line and the menu (the provider's offset) and a little air below it. */
const GAP_PX = 14;

function createView(ctx: Ctx, view: EditorView) {
  const host = document.createElement('div');
  host.className = 'slash-host';
  // A press on the list (its scroll bar, the space between items) must not take the focus from the text. (The items are focusable without being tab stops, so the scrolling list has keyboard access.)
  host.addEventListener('mousedown', (event) => event.preventDefault());
  const root = createRoot(host);
  const provider = new SlashProvider({ content: host, debounce: 0, offset: 6, shouldShow: (v) => slashQuery(v) !== null && state.dismissed === null });
  /**
   * The menu is never taller than the room under the line it opens from (DESIGN.md: it is capped to the space below its opener and scrolls inside itself): on a phone with the
   * on-screen keyboard the room is small, and a menu that runs past the bottom hides the rows it offers. Measured at every update, so typing, scrolling or the keyboard resizing
   * the view all move the cap with the line.
   */
  const capToRoom = (view: EditorView): void => {
    try {
      const line = view.coordsAtPos(view.state.selection.from);
      // The visual viewport, where there is one: a phone's on-screen keyboard shrinks it without changing `innerHeight` (iOS Safari, Android's default `resizes-visual`).
      const bottom = window.visualViewport === undefined || window.visualViewport === null ? window.innerHeight : window.visualViewport.offsetTop + window.visualViewport.height;
      const room = Math.max(MIN_ROOM_PX, bottom - line.bottom - GAP_PX);
      host.style.setProperty('--slash-room', `${String(Math.round(room))}px`);
    } catch {
      /* no layout to ask (the view is going): the stylesheet's own cap stands */
    }
  };
  /** `dismissed`: Escape closed the menu for this paragraph and this text; it stays closed until the text after the slash changes, or the cursor leaves the slash. */
  const state = { kinds: SLASH_KINDS, active: 0, dismissed: null as { start: number; query: string } | null, open: false };

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
    capToRoom(view);
    trackRoom(true);
    render();
  };
  provider.onHide = () => {
    state.open = false;
    trackRoom(false);
    render();
  };

  // The cap is measured again while the menu is open: a scroll moves its line, and the on-screen keyboard resizes the visual viewport.
  const recap = (): void => { if (state.open) capToRoom(view); };
  const trackRoom = (on: boolean): void => {
    const method = on ? 'addEventListener' : 'removeEventListener';
    window[method]('scroll', recap, true);
    window[method]('resize', recap);
    window.visualViewport?.[method]('resize', recap);
    window.visualViewport?.[method]('scroll', recap);
  };

  const spec = {
    update(next: EditorView) {
      const query = slashQuery(next);
      if (query === null || (state.dismissed !== null && (state.dismissed.query !== query || state.dismissed.start !== next.state.selection.$from.start()))) state.dismissed = null;
      const kinds = query === null ? SLASH_KINDS : matchingKinds(query, SLASH_KINDS);
      if (kinds.length !== state.kinds.length || kinds.some((kind, i) => kind !== state.kinds[i])) state.active = 0;
      state.kinds = kinds;
      // The library acts only on the last update of a burst, and skips an update whose document and selection are those of the state before it: a transaction that changes
      // nothing (one the editor or a plugin dispatches a moment after the typing) would make it skip the one that matters. So it is never told the earlier state.
      provider.update(next);
      if (state.open) capToRoom(next);
    },
    destroy() {
      trackRoom(false);
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
      state.dismissed = { start: view.state.selection.$from.start(), query: slashQuery(view) ?? '' };
      provider.hide();
      return true;
    }
    if (count === 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      state.active = (state.active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
      render();
      host.querySelector(`#${slashOptionId(state.kinds[state.active] as BlockKind)}`)?.scrollIntoView?.({ block: 'nearest' }); // the new one, by its id: the render that marks it active has not been committed yet
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
