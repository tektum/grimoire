import { editorViewCtx } from '@milkdown/core';
import type { Ctx, MilkdownPlugin } from '@milkdown/ctx';
import { upload, uploadConfig } from '@milkdown/plugin-upload';
import { Fragment, type Node as ProseNode, type Schema } from '@milkdown/prose/model';
import { Plugin } from '@milkdown/prose/state';
import { Decoration } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';
import { storeFetch } from '../../api/store';
import { log } from '../../logging';
import { anchorPlugin } from './anchor';
import { providedFor } from './host';
import { imagePlugin } from './image-view';
import { attachmentId } from './path';
import { uploadAttachment, type Attachment } from './upload';

/** The image types a browser shows inline: the server signs only these for display (any other type is a download), so only these become image nodes. */
const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

/** What goes into the document for the files that were stored: an image for an image, the file's name as a link to its saved path for any other file. */
export function fragmentFor(attachments: readonly Attachment[], schema: Schema): Fragment {
  const nodes: ProseNode[] = [];
  for (const attachment of attachments) {
    if (nodes.length > 0) nodes.push(schema.text(' '));
    if (INLINE_IMAGE_TYPES.has(attachment.contentType)) nodes.push(schema.nodes['image']!.create({ src: attachment.markdownPath, alt: attachment.fileName }));
    else nodes.push(schema.text(attachment.fileName, [schema.marks['link']!.create({ href: attachment.markdownPath })]));
  }
  return Fragment.from(nodes);
}

/**
 * Uploads every file of a paste or a drop at once. Those that were stored become nodes; each distinct refusal is told once, and a refused file leaves nothing in the
 * document. It never rejects: the plugin that calls it keeps its "in progress" marker for a rejection.
 */
export async function uploadFiles(files: readonly File[], ctx: Ctx): Promise<Fragment> {
  const schema = ctx.get(editorViewCtx).state.schema;
  const provided = providedFor(ctx.get(editorViewCtx).dom);
  const host = provided?.host;
  if (host?.pageId === undefined || host.uploadApi === undefined) {
    host?.notify?.('Files can’t be added to this page');
    return Fragment.empty;
  }
  const deps = { api: host.uploadApi, put: host.put ?? storeFetch, pageId: host.pageId };
  const results = await Promise.all(files.map((file) => uploadAttachment(deps, file)));
  const refusals = new Set<string>();
  const stored: Attachment[] = [];
  for (const result of results) {
    if (result.ok) stored.push(result.attachment);
    else refusals.add(result.message);
  }
  for (const message of refusals) host.notify?.(message);
  return fragmentFor(stored, schema);
}

const uploadWidget = (pos: number, spec: Parameters<typeof Decoration.widget>[2]): Decoration => {
  const dom = document.createElement('span');
  dom.className = 'attachment-uploading';
  dom.setAttribute('aria-busy', 'true');
  dom.textContent = 'Uploading…';
  return Decoration.widget(pos, dom, spec);
};

const uploader = (files: FileList, _schema: Schema, ctx: Ctx): Promise<Fragment> => uploadFiles(Array.from(files), ctx);

const configureUpload: MilkdownPlugin = (ctx) => async () => {
  ctx.update(uploadConfig.key, (prev) => ({ ...prev, uploader, uploadWidgetFactory: uploadWidget }));
};

/** A click on a link to an uploaded file asks for a signed link at that moment and opens it, in the editor and in the read-only view alike; no other link is touched. */
const openOnClick = $prose(
  () =>
    new Plugin({
      props: {
        handleDOMEvents: {
          click: (view, event) => {
            const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
            const id = attachmentId(link?.getAttribute('href'));
            const host = providedFor(view.dom)?.host;
            if (id === null || host === undefined) return false;
            event.preventDefault();
            void openAttachment(host, id);
            return true;
          },
        },
      },
    }),
);

/**
 * The new tab is opened in the click itself (a pop-up blocker allows only that), blank and with no way back to this page, and sent to the signed link when the server has
 * given it; when it has not, or the request failed, the tab is closed again. A host that opens links itself (a test) gets the address instead of a tab.
 */
async function openAttachment(host: NonNullable<ReturnType<typeof providedFor>>['host'], id: string): Promise<void> {
  if (host.api === undefined) return;
  let tab: Window | null = null;
  if (host.open === undefined) {
    tab = window.open('', '_blank');
    if (tab === null) return; // the browser refused it: nothing to send anywhere
    tab.opener = null;
  }
  try {
    const { data, response } = await host.api.GET('/v1/attachments/{id}' as never, { params: { path: { id }, query: { download: true } } } as never);
    const url = (data as { url?: string } | undefined)?.url;
    if (response.ok && url !== undefined) {
      if (host.open !== undefined) host.open(url);
      else tab?.location.replace(url);
      return;
    }
  } catch {
    log('warn', 'web.attachment_open_failed');
  }
  tab?.close();
  host.notify?.("That file isn't available");
}

/** Images, the upload of files by paste and drop, and the opening of attachment links. */
export const attachmentPlugins: MilkdownPlugin[] = [imagePlugin, ...upload, configureUpload, openOnClick, anchorPlugin].flat();
