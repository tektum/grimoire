import { mountReadOnly } from '../../src/editor/core/mount';
import '../../src/ui/global.css';
import '../../src/editor/core/lists.css';
import '../../src/safety/raw-html.css';

/**
 * The real editor on fixed Markdown, in the page's own class names, with no API, no sign-in and no collaboration: enough to show how a page
 * draws raw HTML. `window.__ready` is set when the editor is mounted and editable (the live editor's state, without a connection).
 */
const host = document.getElementById('host');
if (host !== null) {
  const root = document.createElement('div');
  root.className = 'page-editor page-text';
  root.style.cssText = 'max-width: 42rem; margin: 3rem auto; padding: 0 1rem;';
  host.append(root);
  const markdown = new URLSearchParams(location.search).get('md') ?? '';
  void mountReadOnly(root, markdown).then((editor) => {
    editor.setEditable(true);
    (window as unknown as { __ready: boolean }).__ready = true;
  });
}
