import { Check, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ConnectionState } from '../editor/core/connection';
import { TEXTS } from '../editor/core/map-signal';
import './status.css';

type StatusState = Pick<ConnectionState, 'text' | 'unsynced' | 'readOnly' | 'stopped'>;

/** What the page's editor is doing with its connection, as the screen tells it (the same words the page styles by). */
export type StatusScope = 'connecting' | 'synced' | 'offline' | 'stopped' | 'disconnected';

/** How long nothing has to be waiting before the line says Saved again after Saving: typing goes on after each answer of the server, and a line that flipped on every keystroke would be noise. */
export const SAVED_HOLD_MS = 600;
/** How long a save has to take before the line says Saving: a quick save never shows it. */
export const SAVING_DELAY_MS = 400;

const CANNOT_OPEN = "This page can't be opened right now.";

/**
 * The words of the status line (R11.12, R11.14), most important first: a message of the table (a refusal, a limit, the offline text), then Connecting, then, once the page is
 * synced, Saving while the server has not acknowledged changes of this tab and Saved when it has. A reader has nothing to save: Live.
 */
export function statusText(state: Pick<ConnectionState, 'text' | 'unsynced' | 'readOnly' | 'stopped'>, scope: StatusScope): string | null {
  // Stopped for good, the text of a page that is tried again would lie: it is not, until the person asks.
  if (scope === 'stopped' && state.stopped === 'cannot-open' && state.text === TEXTS.cannotOpen) return CANNOT_OPEN;
  if (state.text !== null && state.text !== TEXTS.readOnly) return state.text; // includes the offline text
  if (scope === 'offline') return TEXTS.offline;
  if (scope === 'connecting') return 'Connecting…';
  if (scope === 'synced') return state.readOnly ? 'Live' : state.unsynced > 0 ? 'Saving' : 'Saved';
  return null;
}

/**
 * The status line, and the page's one polite live region: it receives Saving and Saved, the offline text and every refusal or limit text of the table, and never takes the
 * focus. Saving shows only once a change has waited for the server {@link SAVING_DELAY_MS}; once shown, Saved waits for {@link SAVED_HOLD_MS} of nothing waiting.
 */
export function StatusLine({ state, collab, onRetry }: { readonly state: StatusState; readonly collab: StatusScope; readonly onRetry?: () => void }) {
  // The line itself is one element that stays, and only its text changes.
  const line = useRef<HTMLParagraphElement>(null);
  const [saving, setSaving] = useState(false);
  const waiting = state.unsynced > 0;
  useEffect(() => {
    if (waiting === saving) return undefined;
    // Waiting and not yet showing Saving: show it if the save is slow. Showing Saving with nothing waiting: say Saved once it stays so for the hold.
    const timer = setTimeout(() => { setSaving(waiting); }, waiting ? SAVING_DELAY_MS : SAVED_HOLD_MS);
    return () => { clearTimeout(timer); };
  }, [waiting, saving]);
  const text = statusText({ ...state, unsynced: saving ? Math.max(1, state.unsynced) : 0 }, collab);
  const icon = text === TEXTS.offline ? <WifiOff aria-hidden size={14} strokeWidth={1.5} /> : text === 'Saved' ? <Check aria-hidden size={14} strokeWidth={1.5} /> : null;
  // Offline (or a message that needs the person: a refusal, a limit) is a place to come back to, so the line is a Tab stop; Saved and Saving are announcements and never are.
  const tone = text === TEXTS.offline ? ('warn' as const) : undefined;
  // The read-only label is a fact of the page, not something to act on: it never makes the line a Tab stop.
  const needsThePerson = tone === 'warn' || (state.text !== null && state.text !== TEXTS.readOnly);
  return (
    <p ref={line} tabIndex={needsThePerson ? 0 : -1} className="page-status" role="status" aria-live="polite" aria-atomic="true" data-state={collab} data-tone={tone}>
      {icon}
      {text}
      {collab === 'stopped' && state.stopped === 'cannot-open' && state.text === TEXTS.cannotOpen && onRetry !== undefined ? (
        <>
          {' '}
          <button type="button" className="page-status-action" onClick={() => {
              line.current?.focus(); // the button goes away with the attempt: keep the person's place
              onRetry();
            }}>
            Try again
          </button>
        </>
      ) : null}
    </p>
  );
}
