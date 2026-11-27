import { useEffect, useState } from 'react';
import { PanelLeft } from 'lucide-react';
import { Link, Outlet, useLocation } from 'react-router';
import { UserBadge } from '../auth/UserBadge';
import { AdminLink } from './AdminLink';
import { Breadcrumb } from './Breadcrumb';
import { Palette } from '../palette/Palette';
import { useSession } from '../auth/session';
import { ContentsPanel } from '../tree/ContentsPanel';
import { inPageHref } from '../ui/inpage';
import { ErrorBoundary } from './ErrorBoundary';
import { screenKey } from './routes';

/** True once the page has scrolled: the top bar then gets its hairline. */
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = (): void => { setScrolled(window.scrollY > 0); };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => { window.removeEventListener('scroll', update); };
  }, []);
  return scrolled;
}

/** Header, contents area and main (contracts section 3). The contents area holds the tree of the open collection or page once there is a session. */
export function Shell() {
  const { pathname, search } = useLocation();
  const session = useSession();
  const scrolled = useScrolled();
  // On a phone the contents are behind a button; a new screen closes them.
  const [contentsOpen, setContentsOpen] = useState(false);
  useEffect(() => { setContentsOpen(false); }, [pathname]);
  return (
    <div className="shell">
      <a className="skip-link" href={inPageHref(pathname, search, 'main')}>
        Skip to the page
      </a>
      <header className="shell-header" data-scrolled={scrolled || undefined}>
        <button type="button" className="shell-contents-toggle" aria-controls="shell-contents" aria-expanded={contentsOpen} aria-label={contentsOpen ? 'Hide contents' : 'Show contents'} title={contentsOpen ? 'Hide contents' : 'Show contents'} onClick={() => { setContentsOpen((open) => !open); }}>
          <PanelLeft aria-hidden size={16} strokeWidth={1.5} />
        </button>
        <Link to="/" className="shell-brand">Grimoire</Link>
        <Breadcrumb />
        <nav aria-label="Main">
          <Link to="/search">Search</Link> <Link to="/trash">Trash</Link> <AdminLink />
        </nav>
        <UserBadge />
      </header>
      <Palette />
      <div className="shell-body">
        <aside className="shell-contents" id="shell-contents" aria-label="Contents" data-open={contentsOpen || undefined}>
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
