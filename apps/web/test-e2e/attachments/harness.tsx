import { createRoot } from 'react-dom/client';
import { provideAttachments, signedUrlsFrom } from '../../src/editor/attachments';
import { notify, Toaster } from '../../src/ui/primitives';
import { mountReadOnly, type MountedEditor } from '../../src/editor/core/mount';
import '../../src/editor/core/lists.css';
import '../../src/screens/page/page.css';
import '../../src/ui/global.css';

let mounted: MountedEditor | null = null;
let dispose: () => void = () => undefined;
let toaster: ReturnType<typeof createRoot> | null = null;
const PAGE = '99999999-8888-4777-8666-555555555555';

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
    // The API of the page, over `fetch` to `apiBase`, with the paths filled in as the typed client does; the spec answers the requests.
    const call = (method: string) => async (path: string, init: { body?: unknown; params?: { path?: Record<string, string>; query?: Record<string, unknown> } } = {}) => {
      const filled = path.replace(/\{(\w+)\}/g, (_m, name: string) => init.params?.path?.[name] ?? '');
      const query = init.params?.query === undefined ? '' : `?${new URLSearchParams(Object.entries(init.params.query).map(([k, v]) => [k, String(v)]))}`;
      const response = await fetch(`${apiBase}${filled}${query}`, { method, headers: { 'content-type': 'application/json' }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
      const text = await response.text();
      const json = text === '' ? undefined : (JSON.parse(text) as unknown);
      return response.ok ? { data: json, response } : { error: json, response };
    };
    const api = { POST: call('POST'), GET: call('GET') };
    if (toaster === null) {
      const place = document.createElement('div');
      document.body.append(place);
      toaster = createRoot(place);
      toaster.render(<Toaster />);
    }
    dispose = provideAttachments(host, {
      fetchUrls: signedUrlsFrom(api as never),
      pageId: PAGE,
      api: api as never,
      uploadApi: api as never,
      // What the server announces (GET /v1/config), so the refusals say the limit.
      limits: async () => ({ maxBytes: 26_214_400, pendingMax: 10 }),
      notify,
      open: (url) => ((window as unknown as { opened: string[] }).opened ??= []).push(url),
    });
    mounted = await mountReadOnly(host, markdown);
    mounted.setEditable(editable);
  },
  markdown: (): string => mounted?.markdown() ?? '',
};
