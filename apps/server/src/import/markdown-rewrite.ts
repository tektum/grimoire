import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

/**
 * What a link or image target in the archive is replaced with, decided by the caller (the engine knows the items): the address of an imported page (`/p/<url_id>`, which keeps the
 * target's fragment) or of an attachment (`attachments/<id>/<name>`, which never carries one: the editor only opens a download for exactly that shape). `undefined` leaves the
 * target as written.
 */
export interface Resolved { readonly kind: 'page' | 'file'; readonly url: string }
export type ResolveTarget = (target: string, kind: 'link' | 'image') => Resolved | undefined;

export interface RewriteResult {
  readonly markdown: string;
  /** Targets replaced. */
  readonly rewritten: number;
  /** Relative targets that matched nothing, as written (left as they are; each is the warning `unresolved_link`). */
  readonly unresolved: readonly string[];
  /** `http` and `https` image addresses, in document order (left as they are here; the remote image step of stage 4d works from this list). */
  readonly remoteImages: readonly string[];
}

const EXTERNAL = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/; // a scheme, or a protocol-relative address
const REMOTE_IMAGE = /^https?:/i;
const parser = unified().use(remarkParse).use(remarkGfm);
const printer = unified().use(remarkGfm).use(remarkStringify);

/**
 * Rewrites the `link` and `image` nodes of a page's Markdown (R10.2) and nothing else: code, inline code and raw HTML are not links in the tree, so they are never touched. An
 * address with a scheme, a protocol-relative one (`//host/...`) and a fragment-only one are left as they are. A page that has nothing to rewrite is returned exactly as it came in (no parse-and-print
 * reformatting), so importing it with this step gives the same Markdown as importing it without.
 */
export function rewriteMarkdown(markdown: string, resolve: ResolveTarget): RewriteResult {
  const tree = parser.parse(markdown);
  const unresolved: string[] = [];
  const remoteImages: string[] = [];
  let rewritten = 0;
  visit(tree, (node) => {
    if (node.type !== 'link' && node.type !== 'image') return;
    const url = node.url;
    if (url === '' || url.startsWith('#')) return;
    if (EXTERNAL.test(url)) {
      if (node.type === 'image' && REMOTE_IMAGE.test(url)) remoteImages.push(url);
      return;
    }
    const hash = url.indexOf('#');
    const path = hash === -1 ? url : url.slice(0, hash);
    const replacement = resolve(path, node.type);
    if (replacement === undefined) { unresolved.push(url); return; }
    node.url = hash === -1 || replacement.kind === 'file' ? replacement.url : replacement.url + url.slice(hash);
    rewritten += 1;
  });
  return { markdown: rewritten === 0 ? markdown : String(printer.stringify(tree)), rewritten, unresolved, remoteImages };
}
