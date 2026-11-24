import type { ApiClient } from '@tektum/grimoire-api-client';
import type { UploadLimits } from './limits';
import { createUrlBatcher, type FetchUrls, type UrlBatcher } from './urls';

/** What the page gives the editor of one page for attachments. */
export interface AttachmentHost {
  /** The signed links of these ids (`POST /v1/attachments/urls`). */
  readonly fetchUrls: FetchUrls;
  /** The page the files are uploaded to. Absent: the editor has no page, and nothing can be uploaded. */
  readonly pageId?: string;
  /** The client of the session, for the signed link of a file the person opens. */
  readonly api?: ApiClient;
  /** A client that tells nothing to the person by itself (no toast): upload refusals are told once, in the words of the upload. */
  readonly uploadApi?: ApiClient | undefined;
  /** `fetch` for the one request to the file store. */
  readonly put?: typeof fetch;
  /** What the server announced about uploads, read when a refusal needs it. */
  readonly limits?: () => Promise<UploadLimits | undefined>;
  /** Tells the person something (a toast). */
  readonly notify?: (text: string) => void;
  /** Opens a signed link (a download): in another tab. */
  readonly open?: (url: string) => void;
}

interface Provided {
  readonly host: AttachmentHost;
  readonly batcher: UrlBatcher;
}

const provided = new WeakMap<Element, Provided>();

/** Gives the editor mounted in `root` its attachment host; the returned function takes it back (the screen goes away). */
export function provideAttachments(root: Element, host: AttachmentHost): () => void {
  provided.set(root, { host, batcher: createUrlBatcher(host.fetchUrls) });
  return () => void provided.delete(root);
}

/** What was provided for the editor whose surface this is (found from the surface up to the root it was given), or null (an editor with no page). */
export function providedFor(surface: Element): Provided | null {
  for (let node: Element | null = surface; node !== null; node = node.parentElement) {
    const found = provided.get(node);
    if (found !== undefined) return found;
  }
  return null;
}

/** The links of that editor. */
export const linksOf = (surface: Element): UrlBatcher | null => providedFor(surface)?.batcher ?? null;
