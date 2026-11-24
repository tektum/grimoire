import { type FormEvent, useState } from 'react';
import { createDevSignIn, DEV_ROLES, DEV_SIGNIN_MARKER, type DevSignInOptions } from './dev-signin';

/** The development sign-in form: user id, role, and the secret from the `.env` file (a password field: it is never shown, kept or logged). */
export default function DevSignInForm({ options, onSignedIn }: { options: DevSignInOptions; onSignedIn: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    const result = await createDevSignIn(options).signIn({ userId: String(data.get('userId') ?? ''), role: String(data.get('role') ?? ''), secret: String(data.get('secret') ?? '') });
    setBusy(false);
    if (result.ok) onSignedIn();
    else setMessage(result.message);
  }
  return (
    <form className="login-form" data-signin={DEV_SIGNIN_MARKER} onSubmit={(e) => void submit(e)} aria-labelledby="dev-signin-title">
      <h2 id="dev-signin-title">Development sign-in</h2>
      <label>
        User id
        <input name="userId" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
      </label>
      <label>
        Role
        <select name="role" defaultValue="member">
          {DEV_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </label>
      <label>
        Secret
        <input name="secret" type="password" autoComplete="off" required />
      </label>
      {message !== null && (
        <p role="alert" className="login-error">
          {message}
        </p>
      )}
      <button type="submit" data-variant="primary" disabled={busy}>
        Sign in
      </button>
    </form>
  );
}
