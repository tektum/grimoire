import { Editor, defaultValueCtx, rootCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import '../../src/ui/global.css';

/**
 * Milkdown's own commonmark preset on its own (none of this application's plugins or schema), on the Markdown of `?md`: what the library draws for a link by itself.
 * `window.__ready` is set once it is mounted.
 */
const host = document.getElementById('host');
if (host !== null) {
  const markdown = new URLSearchParams(location.search).get('md') ?? '';
  void Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .create()
    .then(() => {
      (window as unknown as { __ready: boolean }).__ready = true;
    });
}
