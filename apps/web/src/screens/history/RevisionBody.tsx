import { useEffect, useRef } from 'react';
import { useSession } from '../../auth/session';
import { provideAttachments, signedUrlsFrom } from '../../editor/attachments';
import '../../editor/core/lists.css';
import { notify } from '../../ui/primitives';
import type { MountedEditor } from '../../editor/core/mount';

export type MountReadOnly = (element: HTMLElement, markdown: string) => Promise<MountedEditor>;

/**
 * A version's Markdown in the read-only editor, so it is drawn by the same rules as a page (links, raw HTML and images: contracts section 8). Each text gets an
 * element of its own, taken down before the next is built.
 */
export function RevisionBody({ markdown, mount }: { readonly markdown: string; readonly mount: MountReadOnly }) {
  const container = useRef<HTMLDivElement>(null);
  const session = useSession();
  useEffect(() => {
    const parent = container.current;
    if (parent === null) return;
    const host = document.createElement('div');
    parent.append(host);
    // The uploaded images of an old version are shown as in the page: through the signed links of the session.
    const takeBack = session === null ? () => undefined : provideAttachments(host, { fetchUrls: signedUrlsFrom(session.api), api: session.api, notify });
    let cancelled = false;
    let mounted: MountedEditor | null = null;
    void mount(host, markdown).then(
      (editor) => {
        if (cancelled) void editor.destroy();
        else {
          mounted = editor;
          host.querySelector('.ProseMirror')?.setAttribute('aria-label', 'Text of this version'); // an editing surface needs a name
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      takeBack();
      void mounted?.destroy();
      host.remove();
    };
  }, [markdown, mount, session]);
  return <div ref={container} data-testid="revision-text" className="history-text page-editor page-text" />;
}
