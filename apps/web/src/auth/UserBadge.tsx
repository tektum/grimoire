import { useApiQuery } from '../api/query';
import './user-badge.css';
import { useSession } from './session';

interface Me {
  readonly name: string;
  readonly role: 'admin' | 'member' | 'viewer';
}

/** Who is signed in, and what they may do: a viewer is shown as read-only. Nothing without a session. */
export function UserBadge() {
  const session = useSession();
  if (session === null) return null;
  return <Badge session={session} />;
}

function Badge({ session }: { session: NonNullable<ReturnType<typeof useSession>> }) {
  const me = useApiQuery<Me>(session.api, '/v1/me');
  if (me.data === undefined) return null;
  return (
    <span className="user-badge">
      <span data-testid="user-name">{me.data.name}</span>{' '}
      <span data-testid="user-role" data-role={me.data.role}>
        {me.data.role === 'viewer' ? 'viewer (read-only)' : me.data.role}
      </span>{' '}
      <button type="button" onClick={() => void session.auth.signOut('manual')}>
        Sign out
      </button>
    </span>
  );
}
