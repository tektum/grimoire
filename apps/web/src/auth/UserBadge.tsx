import { useApiQuery } from '../api/query';
import './user-badge.css';
import { useSession } from './session';

interface Me {
  readonly name: string;
  readonly email: string;
  readonly role: 'admin' | 'member' | 'viewer';
}

/** The name to show: the display name, or the sign-in email when the account has no name (an identity provider may send none). */
export const shownName = (me: { readonly name: string; readonly email: string }): string => (me.name.trim() === '' ? me.email : me.name);

/** Who is signed in, and what they may do: a viewer is shown as read-only. Nothing without a session. */
export function UserBadge() {
  const session = useSession();
  if (session === null) return null;
  return <Badge session={session} />;
}

function Badge({ session }: { session: NonNullable<ReturnType<typeof useSession>> }) {
  const me = useApiQuery<Me>(session.api, '/v1/me');
  // The sign-out button is there whenever there is a session: if `/v1/me` fails, the name and role are missing, and the way out is not.
  return (
    <span className="user-badge">
      {me.data !== undefined && (
        <>
          <span className="user-badge-name" data-testid="user-name" title={shownName(me.data)}>
            {shownName(me.data)}
          </span>{' '}
          <span data-testid="user-role" data-role={me.data.role}>
            {me.data.role === 'viewer' ? 'viewer (read-only)' : me.data.role}
          </span>{' '}
        </>
      )}
      <button type="button" onClick={() => void session.auth.signOut('manual')}>
        Sign out
      </button>
    </span>
  );
}
