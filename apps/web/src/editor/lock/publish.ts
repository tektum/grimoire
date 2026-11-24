import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';
import { blockIdAt } from './block-id';
import { lockContext } from './context';
import { disposeLockNotice } from './notice';

/**
 * Publishes the block the cursor is in through the awareness (`blockId`, R3.17), when it changes, and takes it back when the editor loses the focus or goes: a cursor that is
 * not there must not hold a block. (The awareness is the screen's: it sends at most four updates a second, and only `user`, `cursor` and `blockId`.)
 */
export const blockPublisher = $prose((ctx) => {
  return new Plugin({
    key: new PluginKey('grimoire-block-publisher'),
    view: (view: EditorView) => {
      let last: string | null | undefined;
      const contextNow = () => {
        try {
          return ctx.get(lockContext.key);
        } catch {
          return null; // the editor's context is gone: it is being taken down, and there is nothing to publish to
        }
      };
      const publish = (id: string | null): void => {
        const context = contextNow();
        if (context === null || id === last) return;
        last = id;
        context.awareness.setLocalStateField('blockId', id);
      };
      const current = (): string | null => (view.editable && view.state.selection instanceof TextSelection ? blockIdAt(view.state, view.state.selection.from) : null);
      const onBlur = (): void => publish(null);
      const onFocus = (): void => publish(current());
      view.dom.addEventListener('blur', onBlur);
      view.dom.addEventListener('focus', onFocus);
      return {
        update: () => publish(current()),
        destroy: () => {
          view.dom.removeEventListener('blur', onBlur);
          view.dom.removeEventListener('focus', onFocus);
          publish(null);
          disposeLockNotice(view);
        },
      };
    },
  });
});
