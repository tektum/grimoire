import { Link, Outlet, useLocation } from 'react-router';
import { ErrorBoundary } from './ErrorBoundary';

/** Header, contents area and main (contracts section 3). The contents tree and search arrive with their screens. */
export function Shell() {
  const { pathname } = useLocation();
  return (
    <div className="shell">
      <header className="shell-header">
        <Link to="/">Grimoire</Link>
        <nav aria-label="Main">
          <Link to="/search">Search</Link> <Link to="/trash">Trash</Link>
        </nav>
      </header>
      <div className="shell-body">
        <aside className="shell-contents" aria-label="Contents">
          <p>Contents</p>
        </aside>
        <main className="shell-main">
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
