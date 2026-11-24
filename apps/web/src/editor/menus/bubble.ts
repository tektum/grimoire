import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Ctx, MilkdownPlugin } from '@milkdown/ctx';
import { TooltipProvider, tooltipFactory } from '@milkdown/plugin-tooltip';
import type { EditorView } from '@milkdown/prose/view';
import { Bubble } from './Bubble';
import { LINK_REFUSAL, activeInline, bubbleSelection, linkAt, setLink, toggleInline } from './marks';

const bubble = tooltipFactory('grimoire-bubble');

function createView(ctx: Ctx, view: EditorView) {
  const host = document.createElement('div');
  host.className = 'bubble-host';
  const root = createRoot(host);
  const state = { mode: 'format' as 'format' | 'link', refusal: null as string | null };
  const provider = new TooltipProvider({ content: host, debounce: 0, offset: 8, shouldShow: (v) => v.editable && (state.mode === 'link' || bubbleSelection(v)) });

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
      update(next: EditorView, prev?: Parameters<typeof provider.update>[1]) {
        // Another selection ends the link editor: it was for the one it opened on.
        if (state.mode === 'link' && prev !== undefined && !prev.selection.eq(next.state.selection)) {
          state.mode = 'format';
          state.refusal = null;
        }
        provider.update(next, prev);
        if (host.dataset['show'] === 'true') render();
      },
      destroy() {
        provider.destroy();
        root.unmount();
        host.remove();
      },
    },
    /** Mod-K: the link editor for the selection. */
    key: (event: KeyboardEvent): boolean => {
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
