import { provideAttachments, signedUrlsFrom } from '../../src/editor/attachments';
import { mountReadOnly, type MountedEditor } from '../../src/editor/core/mount';
import '../../src/editor/core/lists.css';
import '../../src/screens/page/page.css';
import '../../src/ui/global.css';

let mounted: MountedEditor | null = null;
let dispose: () => void = () => undefined;

/**
 * Bundled by the attachment specs that need no stack: the page's editor on a text, in a page of the spec's own server, with the attachments of the page asked for from
 * `apiBase` (the spec answers those requests). `window.harness.markdown()` is the document as Markdown.
 */
(window as unknown as { harness: unknown }).harness = {
  mount: async (markdown: string, apiBase: string, editable = false): Promise<void> => {
    dispose();
    await mounted?.destroy();
    const host = document.getElementById('host');
    if (host === null) throw new Error('no host element');
    host.className = 'page-editor page-text';
    const api = {
      POST: async (path: string, init: { body: unknown }) => {
        const response = await fetch(`${apiBase}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) });
        return response.ok ? { data: (await response.json()) as unknown, response } : { error: {}, response };
      },
    };
    dispose = provideAttachments(host, { fetchUrls: signedUrlsFrom(api as never) });
    mounted = await mountReadOnly(host, markdown);
    mounted.setEditable(editable);
  },
  markdown: (): string => mounted?.markdown() ?? '',
};
