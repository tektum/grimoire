import { useState } from 'react';
import { HelpText } from './HelpText';

/**
 * The message that stands in place of a conversion the lock refused: who is in the block, a "Why?" that opens the help, and a way to close it. It is an alert: the person
 * asked for something and did not get it. Escape closes it.
 */
export function LockNotice(props: { message: string; onDismiss: () => void }) {
  const [why, setWhy] = useState(false);
  return (
    <div
      role="alert"
      className="lock-notice"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          props.onDismiss();
        }
      }}
    >
      <p className="lock-message">{props.message}</p>
      <div className="lock-actions">
        <button type="button" aria-expanded={why} aria-controls="lock-why" onClick={() => setWhy(!why)}>
          Why?
        </button>
        <button type="button" onClick={props.onDismiss}>
          Close
        </button>
      </div>
      {why ? (
        <div id="lock-why">
          <HelpText />
          <p>
            <a href="/help" target="_blank" rel="noreferrer">
              The same on the help page
            </a>
          </p>
        </div>
      ) : null}
    </div>
  );
}
