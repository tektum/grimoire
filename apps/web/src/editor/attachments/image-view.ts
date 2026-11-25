import { imageWithLink } from '@tektum/grimoire-editor-schema';
import { $view } from '@milkdown/utils';
import type { Node as ProseNode } from '@milkdown/prose/model';
import type { EditorView, NodeView } from '@milkdown/prose/view';
import { log } from '../../logging';
import { isSafeHref } from '../../safety';
import { linksOf } from './host';
import { attachmentId, placeholderHost } from './path';
import { EXPIRY_MARGIN_MS, type SignedUrl } from './urls';

/** The longest a timer may wait (the browser keeps it in 32 bits). */
const MAX_TIMER_MS = 2_000_000_000;
/** Never sooner than this after a link was set: a link that is already inside its margin must not make a loop of timed refreshes. */
const MIN_REFRESH_MS = 5_000;
/** A refresh before expiry that failed is tried again this many times, this long after, and then left to the error path (the image reloading with the link it has). */
const TIMED_RETRIES = 3;
const TIMED_RETRY_MS = 10_000;

/** The words of a rejection, short enough for an attribute. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : 'unknown').slice(0, 100);

type State = 'loading' | 'ready' | 'failed' | 'external';

/**
 * The image node of the page. An uploaded file (`attachments/<uuid>/<name>`) is shown through a signed link asked for in a batch with the page's other images, and a link
 * that fails or is about to expire is replaced, once, without a reload. Any other source (a web address, a `data:` address, a relative path) is never given to the browser:
 * a placeholder names where it would have come from, so the editor makes no request for it.
 */
export function imageView(node: ProseNode, view: EditorView): NodeView {
  const dom = document.createElement('span');
  dom.className = 'attachment-image';
  dom.contentEditable = 'false';
  let current = node;
  let generation = 0; // a late answer for an earlier source or a destroyed view is dropped
  let timer: ReturnType<typeof setTimeout> | undefined;

  const setTitle = (img: HTMLImageElement): void => {
    const title = current.attrs['title'];
    if (typeof title === 'string' && title !== '') img.title = title;
    else img.removeAttribute('title');
  };
  const setState = (state: State): void => {
    dom.dataset['state'] = state;
    if (state !== 'failed') delete dom.dataset['failedReason'];
  };
  const clear = (): void => {
    generation += 1;
    clearTimeout(timer);
    dom.replaceChildren();
  };

  const placeholder = (src: string): void => {
    setState('external');
    const text = document.createElement('span');
    text.append('External image not loaded: ');
    const host = placeholderHost(src);
    const address = src.startsWith('//') ? `https:${src}` : src; // an address with no scheme but a host: the page's own scheme would be used, and the link says https
    if (/^https?:\/\//i.test(address) && isSafeHref(address)) {
      const a = document.createElement('a');
      a.href = address;
      a.rel = 'noopener noreferrer';
      a.target = '_blank';
      a.textContent = host;
      text.append(a);
    } else text.append(host);
    dom.append(text);
  };

  // Why an image failed is left on the node (`data-failed-reason`) for whoever looks at a failed one: a test that fails, a person with the inspector.
  const failed = (reason: string): void => {
    generation += 1; // final: an answer still on its way must not bring the image back, or set a timer
    clearTimeout(timer);
    setState('failed');
    dom.dataset['failedReason'] = reason;
    dom.replaceChildren(Object.assign(document.createElement('span'), { textContent: "Image couldn't be loaded" }));
  };

  const load = (id: string): void => {
    const mine = generation;
    const links = linksOf(view.dom);
    const img = document.createElement('img');
    img.alt = String(current.attrs['alt'] ?? '');
    setTitle(img);
    dom.append(img);
    setState('loading');
    if (links === null) return failed('no-attachments-host');
    let refreshed = false; // one replacement is asked for because of a failure between two successful loads: a link that keeps failing is not asked for again and again
    const refreshBeforeExpiry = (retries: number): void => {
      links.refresh(id).then(show, () => {
        if (mine !== generation) return;
        log('warn', 'web.attachment_link_refresh_failed', { retriesLeft: retries });
        if (retries > 0) timer = setTimeout(() => refreshBeforeExpiry(retries - 1), TIMED_RETRY_MS);
      });
    };
    const show = (link: SignedUrl): void => {
      if (mine !== generation) return;
      img.src = link.url;
      clearTimeout(timer);
      // Only a link that stays good for longer than the margin and the minimum gets a timer: one that is already near its end (a clock that is ahead of the server's) is not
      // replaced in a loop; the image keeps it and the error path replaces it once if it fails.
      const wait = link.expiresAt - EXPIRY_MARGIN_MS - Date.now();
      if (wait >= MIN_REFRESH_MS) timer = setTimeout(() => refreshBeforeExpiry(TIMED_RETRIES), Math.min(MAX_TIMER_MS, wait));
    };
    const refreshOnce = (): void => {
      if (refreshed) return failed('image-error-after-refresh'); // it failed again after a new link: not a matter of expiry
      refreshed = true;
      links.refresh(id).then(show, (e: unknown) => mine === generation && failed(`refresh-rejected: ${messageOf(e)}`));
    };
    img.addEventListener('load', () => {
      if (mine !== generation) return;
      refreshed = false;
      setState('ready');
    });
    img.addEventListener('error', () => mine === generation && refreshOnce());
    links.url(id).then(show, (e: unknown) => mine === generation && failed(`link-rejected: ${messageOf(e)}`));
  };

  const render = (): void => {
    clear();
    const src = String(current.attrs['src'] ?? '');
    const id = attachmentId(src);
    if (id === null) placeholder(src);
    else load(id);
  };
  render();

  return {
    dom,
    update(next) {
      if (next.type !== current.type) return false;
      const sourceChanged = next.attrs['src'] !== current.attrs['src'];
      current = next;
      if (sourceChanged) render();
      else {
        const img = dom.querySelector('img');
        img?.setAttribute('alt', String(next.attrs['alt'] ?? ''));
        if (img !== null) setTitle(img);
      }
      return true;
    },
    selectNode: () => dom.classList.add('is-selected'),
    deselectNode: () => dom.classList.remove('is-selected'),
    ignoreMutation: () => true,
    destroy: () => clear(),
  };
}

export const imagePlugin = $view(imageWithLink.node, () => imageView);
