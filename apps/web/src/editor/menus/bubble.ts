import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Ctx, MilkdownPlugin } from '@milkdown/ctx';
import { TooltipProvider, tooltipFactory } from '@milkdown/plugin-tooltip';
import type { EditorView } from '@milkdown/prose/view';
import { Bubble } from './Bubble';
import { LINK_REFUSAL, activeInline, bubbleSelection, linkAt, setLink, toggleInline } from './marks';

const bubble = tooltipFactory('grimoire-bubble');
/** How much room above the selection, inside the editor, the bar needs to go there (its height and the gap). */
const BAR_ROOM = 56;

function createView(ctx: Ctx, view: EditorView) {
  const host = document.createElement('div');
  host.className = 'bubble-host';
  const root = createRoot(host);
  /** `dismissed`: Escape put the bar away for this selection; it comes back with the next selection. */
  const state = { mode: 'format' as 'format' | 'link', refusal: null as string | null, dismissed: null as { from: number; to: number } | null };
  const isDismissed = (v: EditorView): boolean => state.dismissed !== null && state.dismissed.from === v.state.selection.from && state.dismissed.to === v.state.selection.to;
  // Above the selection when there is room for it inside the editor (the library reads this object each time it places the bubble), below it otherwise, and always below for the
  // link editor: it is taller than the bar, and above the text it would cover the lines before it (and the title of the page).
  const placing: { placement: 'top' | 'bottom' } = { placement: 'top' };
  const place = (v: EditorView): void => {
    if (state.mode === 'link') {
      placing.placement = 'bottom';
      return;
    }
    try {
      const room = v.coordsAtPos(v.state.selection.from).top - v.dom.getBoundingClientRect().top;
      placing.placement = room >= BAR_ROOM ? 'top' : 'bottom';
    } catch {
      placing.placement = 'top'; // no layout to ask (the view is going): the library's own choice
    }
  };
  const provider = new TooltipProvider({
    content: host,
    debounce: 0,
    offset: 8,
    floatingUIOptions: placing,
    shouldShow: (v) => v.editable && (state.mode === 'link' || (bubbleSelection(v) && !isDismissed(v))),
  });

  const render = (): void => {
    root.render(
      createElement(Bubble, {
        key: state.mode,
        active: activeInline(view.state),
        link: linkAt(view.state),
        mode: state.mode,
        refusal: state.refusal,
        onToggle: (kind) => {
          toggleInline(ctx, kind);
          view.focus();
          render();
        },
        onOpenLink: openLink,
        onApply: (address) => {
          if (setLink(view, address) === 'refused') {
            state.refusal = LINK_REFUSAL; // the document is untouched and the editor stays open, with what was typed
            render();
            return;
          }
          close();
        },
        onCancel: close,
      }),
    );
  };
  const openLink = (): void => {
    state.mode = 'link';
    state.refusal = null;
    render();
    place(view);
    provider.update(view); // placed again: below the selection
  };
  const close = (): void => {
    state.mode = 'format';
    state.refusal = null;
    view.focus();
    render();
  };
  // The press of a button must not take the focus from the text, and a press anywhere else in the bubble than the address field neither.
  host.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    if (state.mode === 'link' && !(next instanceof Node && (host.contains(next) || view.dom.contains(next)))) {
      state.mode = 'format';
      state.refusal = null;
      render();
    }
  });
  provider.onShow = render;
  provider.onHide = () => {
    state.mode = 'format';
    state.refusal = null;
    render();
  };

  return {
    spec: {
      update(next: EditorView, prev?: { selection: { eq(other: unknown): boolean } }) {
        // Another selection ends the link editor: it was for the one it opened on.
        if (state.mode === 'link' && prev !== undefined && !prev.selection.eq(next.state.selection)) {
          state.mode = 'format';
          state.refusal = null;
        }
        if (state.dismissed !== null && !isDismissed(next)) state.dismissed = null; // another selection: the bar is for it
        place(next);
        // The library skips an update whose document and selection are those of the state before it, and keeps only the last update of a burst: it is never told the earlier
        // state, so that a transaction that changes nothing cannot make it skip the update that matters.
        provider.update(next);
        if (host.dataset['show'] === 'true') render();
      },
      destroy() {
        provider.destroy();
        root.unmount();
        host.remove();
      },
    },
    /** Mod-K: the link editor for the selection. Escape, with the bar showing: puts it away and keeps the selection (the link editor has its own Escape). */
    key: (event: KeyboardEvent): boolean => {
      if (event.key === 'Escape' && state.mode === 'format' && host.dataset['show'] === 'true') {
        state.dismissed = { from: view.state.selection.from, to: view.state.selection.to };
        provider.hide();
        return true;
      }
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || !bubbleSelection(view)) return false;
      openLink();
      provider.show();
      return true;
    },
  };
}

/** The bubble over a selection of text: inline formatting and the link editor (addresses are checked against the schema's own list). */
const configure: MilkdownPlugin = (ctx) => () => {
  let current: ReturnType<typeof createView> | null = null;
  ctx.set(bubble.key, {
    view: (view) => {
      current = createView(ctx, view);
      return current.spec;
    },
    props: { handleKeyDown: (_view, event) => current?.key(event) ?? false },
  });
};

export const selectionBubble: MilkdownPlugin[] = [bubble[0], configure, bubble[1]];
