import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Ctx, MilkdownPlugin } from '@milkdown/ctx';
import { BlockProvider, block, blockSpec } from '@milkdown/plugin-block';
import { TextSelection } from '@milkdown/prose/state';
import { editorViewCtx } from '@milkdown/core';
import { allowBlockChange } from '../lock';
import { BLOCK_KINDS, type BlockKind } from './blocks';
import { BlockHandle, HANDLE_MENU_ID } from './BlockHandle';
import { optionId } from './SlashMenu';

/** The block the handle is on, as the library knows it: its element. Where it is in the document is worked out when a kind is chosen, not when the pointer was over it. */
export interface ActiveBlock {
  readonly el: HTMLElement;
}

/**
 * Puts the cursor inside the block the handle is on, so that a command acts on it, and runs the kind. The block is found from its element now, not from where it was when the
 * pointer went over it: in a page that other people edit, what is above it may have changed since.
 */
function turnBlockInto(ctx: Ctx, active: ActiveBlock | null, kind: BlockKind): void {
  const view = ctx.get(editorViewCtx);
  if (active === null || !view.dom.contains(active.el)) return;
  const pos = view.posAtDOM(active.el, 0);
  // A block with no text in it (a divider, a block-level atom) has no place for a cursor: the nearest text block would be turned instead, a neighbour that was not asked for.
  const after = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size)).nodeAfter;
  if (after !== null && after.isAtom && after.isBlock) return; // a block-level atom only: a text block that starts with an image or a break has a place for the cursor
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(Math.min(pos, view.state.doc.content.size)))));
  if (allowBlockChange(ctx, kind, view.state.selection.from)) kind.run(ctx);
  view.focus();
}

/** The handle's element with its button, its menu and its keys. `activeBlock` says which block the pointer is over (the library knows). */
export function createHandleHost(ctx: Ctx, activeBlock: () => ActiveBlock | null) {
  const host = document.createElement('div');
  host.className = 'block-handle';
  const root = createRoot(host);
  const state = { open: false, active: 0 };
  // The block is not dragged: its structure is changed with the menu, not by moving it.
  host.addEventListener(
    'dragstart',
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  const render = (): void => {
    root.render(
      createElement(BlockHandle, {
        open: state.open,
        kinds: BLOCK_KINDS,
        active: state.active,
        onToggle: () => {
          state.open = !state.open;
          state.active = 0;
          render();
        },
        onPick: (kind) => {
          state.open = false;
          render();
          turnBlockInto(ctx, activeBlock(), kind);
        },
        onHover: (index) => {
          state.active = index;
          render();
        },
      }),
    );
  };
  // The first drawing is done at once: the library places the handle by its size, and a handle with nothing in it yet would be placed as if it had no width.
  flushSync(render);
  host.addEventListener('keydown', (event) => {
    if (!state.open) return;
    const count = BLOCK_KINDS.length;
    if (event.key === 'Escape') {
      state.open = false;
      render();
      host.querySelector<HTMLElement>('.block-handle-button')?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      state.active = (state.active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
      render();
      host.querySelector(`#${optionId(HANDLE_MENU_ID, BLOCK_KINDS[state.active] as BlockKind)}`)?.scrollIntoView?.({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      state.open = false;
      render();
      turnBlockInto(ctx, activeBlock(), BLOCK_KINDS[state.active] as BlockKind);
    } else return;
    event.preventDefault();
  });
  return { host, root };
}

/**
 * The handle beside a block, with the menu of kinds to turn that block into. Where the editor cannot be edited there is no handle. One handle lives as long as the editor:
 * the editor may build its plugin views again (the library starts the handle on a later frame, and a handle taken down before that would be put back), so the handle is
 * not tied to a plugin view but is taken down when the editor is.
 */
const configure: MilkdownPlugin = (ctx) => () => {
  let provider: BlockProvider | null = null;
  const { host, root } = createHandleHost(ctx, () => provider?.active ?? null);
  provider = new BlockProvider({ ctx, content: host, getOffset: () => ({ mainAxis: 8 }), getPlacement: () => 'left-start' });
  ctx.set(blockSpec.key, {
    view: () => ({
      update: () => {
        if (!ctx.get(editorViewCtx).editable) provider?.hide();
        provider?.update();
      },
    }),
  });
  return () => {
    provider?.destroy();
    root.unmount();
    host.remove();
  };
};

export const blockHandle: MilkdownPlugin[] = [...block.slice(0, 1), configure, ...block.slice(1)];
