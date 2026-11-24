import { mountReadOnly, type MountedEditor } from '../../src/editor/core/mount';
import '../../src/editor/core/lists.css';
import '../../src/screens/page/page.css';
import '../../src/ui/global.css';

let mounted: MountedEditor | null = null;

/**
 * Bundled by the table specs that need no stack: the page's editor (the shared schema and the editor's plugins, the table controls among them) on a text, made
 * editable, in a page of the spec's own server. `window.harness.markdown()` is the document as Markdown.
 */
(window as unknown as { harness: unknown }).harness = {
  mount: async (markdown: string): Promise<void> => {
    await mounted?.destroy();
    const host = document.getElementById('host');
    if (host === null) throw new Error('no host element');
    host.className = 'page-editor page-text';
    mounted = await mountReadOnly(host, markdown);
    mounted.setEditable(true);
  },
  markdown: (): string => mounted?.markdown() ?? '',
};
