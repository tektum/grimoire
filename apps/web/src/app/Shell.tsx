import { Link, Outlet, useLocation } from 'react-router';
import { UserBadge } from '../auth/UserBadge';
import { useSession } from '../auth/session';
import { ContentsPanel } from '../tree/ContentsPanel';
import { inPageHref } from '../ui/inpage';
import { ErrorBoundary } from './ErrorBoundary';
import { screenKey } from './routes';

/** Header, contents area and main (contracts section 3). The contents area holds the tree of the open collection or page once there is a session. */
export function Shell() {
  const { pathname, search } = useLocation();
  const session = useSession();
  return (
    <div className="shell">
      <a className="skip-link" href={inPageHref(pathname, search, 'main')}>
        Skip to the page
      </a>
      <header className="shell-header">
        <Link to="/">Grimoire</Link>
        <nav aria-label="Main">
          <Link to="/search">Search</Link> <Link to="/trash">Trash</Link>
        </nav>
        <UserBadge />
      </header>
      <div className="shell-body">
        <aside className="shell-contents" aria-label="Contents">
          {session === null ? <p>Contents</p> : <ContentsPanel api={session.api} />}
        </aside>
        <main className="shell-main" id="main" tabIndex={-1}>
          <ErrorBoundary key={screenKey(pathname)}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
