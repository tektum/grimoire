import { LIMIT_TEXT, SOFT_LOCK_HELP } from './texts';

/** What the lock can and cannot do (R3.15), and the limits of editing together in the first version (R3.26, R3.27): on the "Why?" of the lock message and on the help page. */
export function HelpText() {
  return (
    <div className="lock-help">
      <p>{SOFT_LOCK_HELP}</p>
      <p>{LIMIT_TEXT}</p>
    </div>
  );
}
