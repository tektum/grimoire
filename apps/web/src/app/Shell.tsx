import { useEffect, useState } from 'react';
import { PanelLeft } from 'lucide-react';
import { Link, Outlet, useLocation } from 'react-router';
import { useApiQuery } from '../api/query';
import { UserBadge, shownName } from '../auth/UserBadge';
import { initialsOf } from '../presence/model';
import { AdminLink } from './AdminLink';
import { Breadcrumb } from './Breadcrumb';
import { PageControlsProvider, PageControlsSlot, useBarRoom } from './page-controls';
import { Palette } from '../palette/Palette';
import { shortcutHint } from '../palette/open';
import { useSession } from '../auth/session';
import { ContentsPanel } from '../tree/ContentsPanel';
import { inPageHref } from '../ui/inpage';
import { ErrorBoundary } from './ErrorBoundary';
import { screenKey } from './routes';

/** True once the page has scrolled: the top bar then gets its hairline. */
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = (): void => {
      setScrolled(window.scrollY > 0);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => {
      window.removeEventListener('scroll', update);
    };
  }, []);
  return scrolled;
}

/** The person's initials in a disc: what the menu button on a phone shows, so that it is not the page's "···". Nothing but the disc until the name is known, and without a session. */
function Avatar() {
  const session = useSession();
  return (
    <span className="shell-avatar" aria-hidden="true">
      {session === null ? null : <Initials api={session.api} />}
    </span>
  );
}

function Initials({ api }: { api: NonNullable<ReturnType<typeof useSession>>['api'] }) {
  const me = useApiQuery<{ name: string; email: string }>(api, '/v1/me');
  return <>{me.data === undefined ? '' : initialsOf(shownName(me.data))}</>;
}

/** Where the person goes from anywhere: Search, Trash, and Admin for an administrator, and who is signed in. On a phone it is the menu behind the avatar; from 641px up it is the foot of the contents. */
function AccountNav() {
  return (
    <>
      <nav aria-label="Main">
        {/* Search opens the palette, so its row says the key that does that here (the only global shortcut the app has). */}
        <Link to="/search" className="shell-actions-search">
          Search <kbd aria-hidden="true">{shortcutHint()}</kbd>
        </Link>{' '}
        <Link to="/trash">Trash</Link> <AdminLink />
      </nav>
      <UserBadge />
    </>
  );
}

/** Header, contents area and main (contracts section 3). The contents area holds the tree of the open collection or page once there is a session. */
export function Shell() {
  const { pathname, search } = useLocation();
  const session = useSession();
  const scrolled = useScrolled();
  const room = useBarRoom();
  const [hasParent, setHasParent] = useState(false);
  // On a phone the contents are behind a button; a new screen closes them.
  const [contentsOpen, setContentsOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  useEffect(() => {
    setContentsOpen(false);
    setActionsOpen(false);
  }, [pathname]);
  return (
    <PageControlsProvider>
      <div className="shell">
        <a className="skip-link" href={inPageHref(pathname, search, 'main')}>
          Skip to the page
        </a>
        <header className="shell-header" data-scrolled={scrolled || undefined} data-parent={hasParent || undefined}>
          <button
            type="button"
            className="shell-contents-toggle"
            aria-controls="shell-contents"
            aria-expanded={contentsOpen}
            aria-label={contentsOpen ? 'Hide contents' : 'Show contents'}
            title={contentsOpen ? 'Hide contents' : 'Show contents'}
            onClick={() => {
              // The drawer and the account menu are one thing at a time: the menu would sit on top of the tree it just opened.
              setActionsOpen(false);
              setContentsOpen((open) => !open);
            }}
          >
            <PanelLeft aria-hidden size={16} strokeWidth={1.5} />
          </button>
          <Link to="/" className="shell-brand">
            Grimoire
          </Link>
          <Breadcrumb onParent={setHasParent} />
          <PageControlsSlot />
          {/* The person's own button, so that it cannot be taken for the page's menu ("···") beside it: the account and the places are behind it. */}
          <button
            type="button"
            className="shell-actions-toggle"
            aria-controls="shell-actions"
            aria-expanded={actionsOpen}
            aria-label={actionsOpen ? 'Hide menu' : 'Show menu'}
            title={actionsOpen ? 'Hide menu' : 'Show menu'}
            onClick={() => {
              setContentsOpen(false);
              setActionsOpen((open) => !open);
            }}
          >
            <Avatar />
          </button>
          {/* On a phone these sit behind the button above: one compact bar, and the breadcrumb under it. */}
          <div className="shell-actions" id="shell-actions" data-open={actionsOpen || undefined}>
            {room ? null : <AccountNav />}
          </div>
        </header>
        <Palette />
        <div className="shell-body">
          <aside className="shell-contents" id="shell-contents" aria-label="Contents" data-open={contentsOpen || undefined}>
            {session === null ? <p>Contents</p> : <ContentsPanel api={session.api} />}
            {room && session !== null ? (
              <div className="shell-account">
                <AccountNav />
              </div>
            ) : null}
          </aside>
          <main className="shell-main" id="main" tabIndex={-1}>
            <ErrorBoundary key={screenKey(pathname)}>
              <Outlet />
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </PageControlsProvider>
  );
}
