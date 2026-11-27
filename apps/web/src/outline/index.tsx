import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import './outline.css';

const WIDE = '(min-width: 1280px)';
const HEADINGS = 'h1, h2, h3, h4, h5, h6';
const MAX_INDENT = 3;
const DEBOUNCE_MS = 200;

interface Entry {
  /** Stays the same for the same heading element however the list around it changes: the key of its link, so a link that has the focus is not rebuilt. */
  readonly id: number;
  readonly text: string;
  readonly level: number;
}

const ids = new WeakMap<Element, number>();
let nextId = 0;
const idOf = (element: Element): number => {
  let id = ids.get(element);
  if (id === undefined) {
    id = nextId;
    nextId += 1;
    ids.set(element, id);
  }
  return id;
};

/** What the editor puts into a heading besides the person's own text: the labels and carets of other people's cursors. */
const NOT_TEXT = '.ProseMirror-yjs-cursor, .ProseMirror-widget, .cursor-label';

/** The text of a heading as the person typed it, without the cursors of others drawn inside it, with the spaces made one. */
function textOf(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(NOT_TEXT).forEach((extra) => { extra.remove(); });
  return (copy.textContent ?? '').replace(/[\s\u200b-\u200d\u2060\ufeff]+/gu, ' ').trim();
}

/** The editor's element in the page screen's layout (page.css), or null when there is no page. */
const editorElement = (): HTMLElement | null => document.querySelector<HTMLElement>('.page-layout .page-editor');

/** The headings the editor draws (a paragraph with a level of 1 to 6 is drawn as h1 to h6), in order, without the ones that hold only whitespace. */
function headingsOf(root: HTMLElement): { element: HTMLElement; entry: Entry }[] {
  return Array.from(root.querySelectorAll<HTMLElement>(HEADINGS))
    .map((element) => ({ element, entry: { id: idOf(element), text: textOf(element), level: Number(element.tagName.slice(1)) } }))
    .filter(({ entry }) => entry.text !== '');
}

/** The last heading at or before the cursor when the cursor is in the editor, else the last one whose top has passed the top of the window. */
function currentIndex(root: HTMLElement, found: readonly { element: HTMLElement }[]): number {
  const anchor = window.getSelection()?.anchorNode ?? null;
  let current = -1;
  if (anchor !== null && root.contains(anchor)) {
    found.forEach(({ element }, i) => {
      if (element === anchor || element.contains(anchor) || (element.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) current = i;
    });
    return current;
  }
  found.forEach(({ element }, i) => {
    if (element.getBoundingClientRect().top <= 100) current = i;
  });
  return current;
}

/**
 * The outline of the open page in the right margin (R11.6, R11.17): the headings of the editor's document as links that put the cursor in the heading and scroll to it.
 * It reads what the editor draws, follows changes a moment after they happen, shows on windows 1,200 pixels wide and more, and is one stop of the Tab key with the
 * arrow keys moving between its links.
 */
export function Outline() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [current, setCurrent] = useState(-1);
  /** The heading (by id) whose link is the one Tab stop; the first link when it is not in the list. */
  const [stop, setStop] = useState<number | null>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const onChange = (): void => { setWide(query.matches); };
    query.addEventListener('change', onChange);
    return () => { query.removeEventListener('change', onChange); };
  }, []);

  useEffect(() => {
    const root = wide ? editorElement() : null;
    if (root === null) {
      setEntries([]);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      const found = headingsOf(root);
      setEntries((before) => (before.length === found.length && before.every((e, i) => e.id === found[i]?.entry.id && e.text === found[i].entry.text && e.level === found[i].entry.level) ? before : found.map((f) => f.entry)));
      setCurrent(currentIndex(root, found));
    };
    const later = (): void => {
      clearTimeout(timer);
      timer = setTimeout(read, DEBOUNCE_MS);
    };
    read();
    const observer = new MutationObserver(later);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    document.addEventListener('selectionchange', later);
    window.addEventListener('scroll', later, { passive: true });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('selectionchange', later);
      window.removeEventListener('scroll', later);
    };
  }, [wide]);

  /**
   * Puts the cursor at the start of the heading and brings it into view. The document is read again at the click, because the list may be a moment behind; the heading
   * is the one at the same place if it still has the clicked text and level, else the nearest one that has, else none (nothing moves rather than going somewhere else).
   */
  const go = useCallback((index: number, clicked: Entry): void => {
    const root = editorElement();
    if (root === null) return;
    const fresh = headingsOf(root);
    const same = (i: number): boolean => fresh[i]?.entry.text === clicked.text && fresh[i].entry.level === clicked.level;
    let at = -1;
    if (same(index)) at = index;
    else for (let distance = 1; distance <= Math.max(index, fresh.length - 1 - index) && at < 0; distance += 1) at = same(index - distance) ? index - distance : same(index + distance) ? index + distance : -1;
    const target = fresh[at]?.element;
    if (target === undefined) return;
    const surface = root.querySelector<HTMLElement>('.ProseMirror') ?? root;
    surface.focus({ preventScroll: true });
    window.getSelection()?.collapse(target, 0);
    // A heading already in the window stays where it is (the page does not jump); one that is not comes to the middle of it.
    const box = target.getBoundingClientRect();
    target.scrollIntoView({ block: box.top >= 0 && box.bottom <= window.innerHeight ? 'nearest' : 'center' });
  }, []);

  const move = (event: KeyboardEvent<HTMLUListElement>): void => {
    const links = Array.from(list.current?.querySelectorAll<HTMLAnchorElement>('a') ?? []);
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 : null;
    if (next === null || at < 0) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(links.length - 1, next));
    links[target]?.focus(); // its onFocus makes it the Tab stop
  };

  if (!wide || entries.length === 0) return null;
  return (
    <nav aria-label="Page outline" className="outline">
      <ul ref={list} onKeyDown={move}>
        {entries.map((entry, i) => (
          <li key={entry.id}>
            <a
              href="#"
              data-indent={Math.min(entry.level, MAX_INDENT + 1) - 1}
              style={{ '--indent': Math.min(entry.level, MAX_INDENT + 1) - 1 } as React.CSSProperties}
              tabIndex={entry.id === (entries.some((e) => e.id === stop) ? stop : entries[0]?.id) ? 0 : -1}
              {...(i === current ? { 'aria-current': 'location' as const } : {})}
              onFocus={() => { setStop(entry.id); }}
              onClick={(event) => {
                event.preventDefault();
                go(i, entry);
              }}
            >
              {entry.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
