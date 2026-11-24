import { imageWithLink } from '@tektum/grimoire-editor-schema';
import { $view } from '@milkdown/utils';
import type { Node as ProseNode } from '@milkdown/prose/model';
import type { EditorView, NodeView } from '@milkdown/prose/view';
import { isSafeHref } from '../../safety';
import { linksOf } from './host';
import { attachmentId, placeholderHost } from './path';
import { EXPIRY_MARGIN_MS, type SignedUrl } from './urls';

/** The longest a timer may wait (the browser keeps it in 32 bits). */
const MAX_TIMER_MS = 2_000_000_000;
/** Never sooner than this after a link was set: a link that is already inside its margin must not make a loop. */
const MIN_REFRESH_MS = 5_000;

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

  const setState = (state: State): void => { dom.dataset['state'] = state; };
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
    if (/^https?:\/\//i.test(src) && isSafeHref(src)) {
      const a = document.createElement('a');
      a.href = src;
      a.rel = 'noopener noreferrer';
      a.target = '_blank';
      a.textContent = host;
      text.append(a);
    } else text.append(host);
    dom.append(text);
  };

  const failed = (): void => {
    clearTimeout(timer);
    setState('failed');
    dom.replaceChildren(Object.assign(document.createElement('span'), { textContent: "Image couldn't be loaded" }));
  };

  const load = (id: string): void => {
    const mine = generation;
    const links = linksOf(view.dom);
    const img = document.createElement('img');
    img.alt = String(current.attrs['alt'] ?? '');
    dom.append(img);
    setState('loading');
    if (links === null) return failed();
    let refreshedAt = -Infinity; // the last time a replacement was asked for because of a failure
    const show = (link: SignedUrl): void => {
      if (mine !== generation) return;
      img.src = link.url;
      clearTimeout(timer);
      const wait = Math.min(MAX_TIMER_MS, Math.max(MIN_REFRESH_MS, link.expiresAt - EXPIRY_MARGIN_MS - Date.now()));
      timer = setTimeout(() => void links.refresh(id).then(show, () => undefined), wait);
    };
    const refreshOnce = (): void => {
      if (Date.now() - refreshedAt < MIN_REFRESH_MS) return failed(); // it failed again just after a new link: not a matter of expiry
      refreshedAt = Date.now();
      links.refresh(id).then(show, () => mine === generation && failed());
    };
    img.addEventListener('load', () => mine === generation && setState('ready'));
    img.addEventListener('error', () => mine === generation && refreshOnce());
    links.url(id).then(show, () => mine === generation && failed());
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
      else dom.querySelector('img')?.setAttribute('alt', String(next.attrs['alt'] ?? ''));
      return true;
    },
    selectNode: () => dom.classList.add('is-selected'),
    deselectNode: () => dom.classList.remove('is-selected'),
    ignoreMutation: () => true,
    destroy: () => clear(),
  };
}

export const imagePlugin = $view(imageWithLink.node, () => imageView);
