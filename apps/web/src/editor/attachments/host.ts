import { createUrlBatcher, type FetchUrls, type UrlBatcher } from './urls';

/** What the page gives the editor of one page for attachments. */
export interface AttachmentHost {
  /** The signed links of these ids (`POST /v1/attachments/urls`). */
  readonly fetchUrls: FetchUrls;
}

interface Provided {
  readonly batcher: UrlBatcher;
}

const provided = new WeakMap<Element, Provided>();

/** Gives the editor mounted in `root` its attachment host; the returned function takes it back (the screen goes away). */
export function provideAttachments(root: Element, host: AttachmentHost): () => void {
  provided.set(root, { batcher: createUrlBatcher(host.fetchUrls) });
  return () => void provided.delete(root);
}

/** The links of the editor whose surface this is (found from the surface up to the root it was given), or null when none was provided (an editor with no page). */
export function linksOf(surface: Element): UrlBatcher | null {
  for (let node: Element | null = surface; node !== null; node = node.parentElement) {
    const found = provided.get(node);
    if (found !== undefined) return found.batcher;
  }
  return null;
}
