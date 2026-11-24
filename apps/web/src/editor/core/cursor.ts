import { COLLAB_COLOURS, colourIndex, labelText } from '../../ui/collab';
import type { Directory } from './directory';

/** A remote person's name label shows when they arrive and for this long after each move, then hides. */
export const LABEL_MS = 3000;

const idOf = (user: unknown): string | null => {
  if (typeof user !== 'object' || user === null) return null;
  const id = (user as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
};
/** Only the id of what a peer published is used: the colour is derived from it, never read from `user.color`. */
const colourOf = (id: string | null): string => COLLAB_COLOURS[colourIndex(id ?? '')]!;

export interface CursorTimers {
  setTimeout(fn: () => void, ms: number): unknown;
}

/**
 * The remote cursor and selection of the collaboration plugin. A cursor is a caret in the person's colour and a label with the directory name
 * ("Someone" when unknown): the label is set as text, and nothing in them is taken from a name or colour the peer published.
 */
export function cursorBuilders(directory: Directory, timers: CursorTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms) }) {
  const labels = new Set<{ id: string; label: HTMLElement }>();
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
      // The plugin builds a new caret on every move of a remote cursor and drops the old one: the dropped labels are let go here.
      for (const entry of labels) if (!entry.label.isConnected) labels.delete(entry);
      const id = idOf(user);
      const colour = colourOf(id);
      const caret = document.createElement('span');
      caret.className = 'ProseMirror-yjs-cursor cursor';
      caret.style.setProperty('--cursor', colour);
      caret.style.setProperty('--cursor-text', labelText(colour));
      const label = document.createElement('div');
      label.className = 'cursor-label cursor-label--shown';
      if (id !== null) {
        directory.request([id]);
        labels.add({ id, label });
      }
      label.textContent = id === null ? 'Someone' : directory.nameOf(id);
      timers.setTimeout(() => label.classList.remove('cursor-label--shown'), LABEL_MS);
      // The word joiners keep the caret from joining the text around it, as in the plugin's own cursor.
      caret.append(document.createTextNode('\u2060'), label, document.createTextNode('\u2060'));
      return caret;
    },
    selectionBuilder(user: unknown): { class: string; style: string } {
      return { class: 'ProseMirror-yjs-selection', style: `background-color: ${colourOf(idOf(user))}33` };
    },
  };
}
