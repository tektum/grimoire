import { useEffect, useRef } from 'react';
import type { MountedEditor } from '../../editor/core/mount';
import { isSafeHref } from '../../safety';

/** A link whose address `isSafeHref` refuses stops being a link: its text stays (contracts section 8, rule 1). */
function removeUnsafeLinks(root: ParentNode): void {
  for (const a of Array.from(root.querySelectorAll('a'))) {
    if (!isSafeHref(a.getAttribute('href'))) a.replaceWith(document.createTextNode(a.textContent ?? ''));
  }
}

export type MountReadOnly = (element: HTMLElement, markdown: string) => Promise<MountedEditor>;

/**
 * A version's Markdown in the read-only editor, so it is drawn by the same rules as a page (links, raw HTML and images: contracts section 8). Each text gets an
 * element of its own, taken down before the next is built.
 */
export function RevisionBody({ markdown, mount }: { readonly markdown: string; readonly mount: MountReadOnly }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const parent = container.current;
    if (parent === null) return;
    const host = document.createElement('div');
    parent.append(host);
    // Whatever the editor draws, now or later, is checked: a link is only ever drawn with an address the one rule allows.
    const watch = new MutationObserver(() => { removeUnsafeLinks(host); });
    watch.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    let cancelled = false;
    let mounted: MountedEditor | null = null;
    void mount(host, markdown).then(
      (editor) => {
        if (cancelled) void editor.destroy();
        else {
          mounted = editor;
          removeUnsafeLinks(host);
          host.querySelector('.ProseMirror')?.setAttribute('aria-label', 'Text of this version'); // an editing surface needs a name
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      watch.disconnect();
      void mounted?.destroy();
      host.remove();
    };
  }, [markdown, mount]);
  return <div ref={container} data-testid="revision-text" className="history-text" />;
}
