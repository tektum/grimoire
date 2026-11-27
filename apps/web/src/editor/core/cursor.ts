import { COLLAB_COLOURS, caretColour, colourIndex, labelText } from '../../ui/collab';
import type { Directory } from './directory';

/** A remote person's name flag shows when they arrive and for this long after each move, then shrinks to a dot (docs/DESIGN.md, decision 3). */
export const LABEL_MS = 2000;
/** The sticky top bar over the page: a flag above a line just under it would be hidden by it. */
export const TOP_BAR_PX = 44;
/** The gap between the flag and the line it names. */
const CLEARANCE_PX = 2;
/** The flag's height when it cannot be measured yet: Inter 11 on an 11px line with 2px of padding above and below. */
const FLAG_PX = 15;

const idOf = (user: unknown): string | null => {
  if (typeof user !== 'object' || user === null) return null;
  const id = (user as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
};
/** Only the id of what a peer published is used: the colour is derived from it, never read from `user.color`. */
const colourOf = (id: string | null): string => COLLAB_COLOURS[colourIndex(id ?? '')]!;

/**
 * Whether the flag of `caret` goes below the line instead of above it: when a heading sits directly above the caret's line (the caret is on the first
 * line of its top-level block and the block before it is a heading), or when the line is so near the top of the viewport that the top bar would cover the flag.
 */
export function flipsBelow(caret: HTMLElement, label: HTMLElement): boolean {
  const line = caret.getBoundingClientRect();
  if (line.top - CLEARANCE_PX - (label.offsetHeight || FLAG_PX) < TOP_BAR_PX) return true;
  let block: HTMLElement = caret;
  while (block.parentElement !== null && !block.parentElement.classList.contains('ProseMirror')) block = block.parentElement;
  const before = block.previousElementSibling;
  return before !== null && /^H[1-6]$/.test(before.tagName) && line.top < block.getBoundingClientRect().top + line.height;
}

export interface CursorTimers {
  setTimeout(fn: () => void, ms: number): unknown;
}

/**
 * The remote cursor and selection of the collaboration plugin. A cursor is a caret in the person's caret colour for the theme and a flag with the directory
 * name ("Someone" when unknown) in the person's fixed colour: the flag is set as text, and nothing in them is taken from a name or colour the peer published.
 * The flag shows on arrival and for `LABEL_MS` after each move (the plugin builds a new caret on every move), then the caret takes the dot state
 * (`cursor--dot`); hovering the caret shows the flag again. Whether the flag goes below the line is decided when it shows.
 */
export function cursorBuilders(directory: Directory, timers: CursorTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms) }) {
  const labels = new Set<{ id: string; label: HTMLElement }>();
  let pruning = false;
  const unsubscribe = directory.subscribe(() => {
    for (const entry of labels) {
      if (!entry.label.isConnected) labels.delete(entry);
      else entry.label.textContent = directory.nameOf(entry.id);
    }
  });
  return {
    /** How many labels are being followed (for the tests: it must not grow with every move of a remote cursor). */
    tracked: () => labels.size,
    /** Stops following the directory and lets go of the labels: the editor is gone. */
    dispose(): void {
      unsubscribe();
      labels.clear();
    },
    cursorBuilder(user: unknown): HTMLElement {
      // The plugin builds a new caret on every move of a remote cursor and drops the old one. The dropped labels are let go once the render is done:
      // a caret is built before it is put into the page, so a label that is not in the page yet must not be let go while the same render builds the next.
      if (!pruning) {
        pruning = true;
        queueMicrotask(() => {
          pruning = false;
          for (const entry of labels) if (!entry.label.isConnected) labels.delete(entry);
        });
      }
      const id = idOf(user);
      const index = colourIndex(id ?? '');
      const colour = COLLAB_COLOURS[index]!;
      const caret = document.createElement('span');
      caret.className = 'ProseMirror-yjs-cursor cursor';
      if (id !== null) caret.dataset.userId = id;
      caret.style.setProperty('--cursor', colour);
      caret.style.setProperty('--cursor-caret', caretColour(index));
      caret.style.setProperty('--cursor-text', labelText(colour));
      const label = document.createElement('div');
      label.className = 'cursor-label cursor-label--shown';
      if (id !== null) {
        directory.request([id]);
        labels.add({ id, label });
      }
      label.textContent = id === null ? 'Someone' : directory.nameOf(id);
      // The caret is put into the page in the same render that builds it, so its place is known once the render is done.
      const place = (): void => {
        if (caret.isConnected) label.toggleAttribute('data-flip', flipsBelow(caret, label));
      };
      queueMicrotask(place);
      caret.addEventListener('mouseenter', place);
      timers.setTimeout(() => {
        label.classList.remove('cursor-label--shown');
        caret.classList.add('cursor--dot');
      }, LABEL_MS);
      // The word joiners keep the caret from joining the text around it, as in the plugin's own cursor.
      caret.append(document.createTextNode('\u2060'), label, document.createTextNode('\u2060'));
      return caret;
    },
    selectionBuilder(user: unknown): { class: string; style: string } {
      // The person's colour at 18% (0x2e of 0xff), drawn under the reader's own selection.
      return { class: 'ProseMirror-yjs-selection', style: `background-color: ${colourOf(idOf(user))}2e` };
    },
  };
}
