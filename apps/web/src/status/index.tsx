import { useEffect, useState } from 'react';
import type { ConnectionState } from '../editor/core/connection';
import { TEXTS } from '../editor/core/map-signal';

type StatusState = Pick<ConnectionState, 'text' | 'unsynced' | 'changes' | 'readOnly'>;

/** What the page's editor is doing with its connection, as the screen tells it (the same words the page styles by). */
export type StatusScope = 'connecting' | 'synced' | 'offline' | 'stopped' | 'disconnected';

/** How long nothing has to be waiting before the line says Saved: typing goes on after each answer of the server, and a line that flipped on every keystroke would be noise. */
export const SAVED_HOLD_MS = 600;

/**
 * The words of the status line (R11.12, R11.14), most important first: a message of the table (a refusal, a limit, the offline text), then Connecting, then, once the page is
 * synced, Saving while the server has not acknowledged changes of this tab and Saved when it has. A reader has nothing to save: Live.
 */
export function statusText(state: Pick<ConnectionState, 'text' | 'unsynced' | 'readOnly'>, scope: StatusScope): string | null {
  if (state.text !== null && state.text !== TEXTS.readOnly) return state.text; // includes the offline text
  if (scope === 'offline') return TEXTS.offline;
  if (scope === 'connecting') return 'Connecting…';
  if (scope === 'synced') return state.readOnly ? 'Live' : state.unsynced > 0 ? 'Saving' : 'Saved';
  return null;
}

/**
 * The status line, and the page's one polite live region: it receives Saving and Saved, the offline text and every refusal or limit text of the table, and never takes the
 * focus. Saving shows at once; Saved waits for {@link SAVED_HOLD_MS} of nothing waiting.
 */
export function StatusLine({ state, collab }: { readonly state: StatusState; readonly collab: StatusScope }) {
  // `settled` is the last change the line has shown as saved. A change that was acknowledged before the screen drew still counts as one (`changes` went up), so Saving shows
  // for the moment however fast the server is; the line itself is one element that stays, and only its text changes.
  const [settled, setSettled] = useState(state.changes);
  const waiting = state.unsynced > 0;
  useEffect(() => {
    if (waiting || settled === state.changes) return undefined;
    const timer = setTimeout(() => { setSettled(state.changes); }, SAVED_HOLD_MS);
    return () => { clearTimeout(timer); };
  }, [waiting, settled, state.changes]);
  const saving = waiting || settled !== state.changes;
  const text = statusText({ ...state, unsynced: saving ? Math.max(1, state.unsynced) : 0 }, collab);
  return (
    <p className="page-status" role="status" aria-live="polite" aria-atomic="true" data-state={collab}>
      {text}
    </p>
  );
}
