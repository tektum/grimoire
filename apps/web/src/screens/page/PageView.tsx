import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { pagePath } from '../../tree/model';
import { ConnectionManager, type ConnectionState } from '../../editor/core/connection';
import type { MountedEditor } from '../../editor/core/mount';
import { log } from '../../logging';
import { Outline } from '../../outline';
import { StatusLine } from '../../status';
import { useSession } from '../../auth/session';
import { CLIENT_VERSION } from '../../version';
import type { components } from '@tektum/grimoire-api-client';
import { clientOf, lazyLimits, provideAttachments, quietApiOf, signedUrlsFrom } from '../../editor/attachments';
import { sessionDirectory } from '../../editor/core/directory';
import { queryKey, useApiQuery } from '../../api/query';
import { useTreeActions } from '../../tree/actions';
import { recheckMinClientVersion } from '../../gate/recheck';
import { notify } from '../../ui/primitives';
import { ResetPageDialog } from '../admin/ResetPageDialog';
import { PageNotFound } from './PageNotFound';
import { latestOnly, verdictOf } from './latest';
import { PageMenu } from './PageMenu';
import { PageTitle } from './PageTitle';
import { type PageResult, titled } from './usePage';
import { ResetNotice } from './ResetNotice';
import { realEngine, type Engine } from './engine';
import '../../editor/core/cursors.css';
import '../../editor/core/lists.css';
import '../../safety/raw-html.css';
import './page.css';

export type PageMeta = components['schemas']['Page'];
export type CollabState = 'connecting' | 'synced' | 'offline' | 'stopped' | 'disconnected';

export const STALE_TEXT = 'This text may be a few seconds behind the live page.';
const tails = new WeakMap<HTMLElement, Promise<unknown>>();
/** Runs the steps that build and destroy editors in one element one after the other: a destroy always finishes before the next build. */
const queue = (element: HTMLElement, step: () => Promise<void>): Promise<void> => {
  const next = (tails.get(element) ?? Promise.resolve()).then(step, step);
  tails.set(
    element,
    next.catch(() => undefined),
  );
  return next;
};

/** The default of `hiddenDisconnectMs` (10 minutes), when the session carries none. */
const DEFAULT_HIDDEN_DISCONNECT_MS = 600_000;

const IDLE: ConnectionState = { phase: 'idle', stopped: null, text: null, notice: null, banner: null, readOnly: false, offline: false, unsynced: 0, changes: 0, copy: null, generation: 0, suspended: false };

export function PageView({ page, engine = realEngine, onReplaced }: { page: PageMeta; engine?: Engine; onReplaced?: () => void }) {
  const session = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ConnectionState>(IDLE);
  const [liveReady, setLiveReady] = useState(false);
  const [stale, setStale] = useState(false);
  const [showingSaved, setShowingSaved] = useState(false);
  const editableRef = useRef<(editable: boolean) => void>(() => undefined);
  const permissionReadOnly = page.myPermission === 'read-only';
  // The effect below outlives a page response: it reads what the person may do now, not what the first response said.
  // Who is signed in (the same read as the badge's): the id published with the cursor. It may arrive after the editor, and is read when it is needed.
  const me = useApiQuery<{ id: string; role?: string }>(session?.api ?? (null as never), '/v1/me', undefined, { enabled: session !== null });
  const managerRef = useRef<ConnectionManager | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const meRef = useRef<string | null>(null);
  meRef.current = me.data?.id ?? null;
  const permissionRef = useRef(permissionReadOnly);
  permissionRef.current = permissionReadOnly;
  const staleRef = useRef(page.markdownStale);
  staleRef.current = page.markdownStale;
  const replacedRef = useRef(onReplaced);
  replacedRef.current = onReplaced;
  const readOnly = permissionReadOnly || state.readOnly;
  const restore = (location.state as { restoreMarkdown?: unknown } | null)?.restoreMarkdown;
  const restoreRef = useRef(typeof restore === 'string' ? restore : null);
  // A page just made opens with its title field (the sign is in the navigation state). It is read once, here, and taken out of the state at once: a return to this page from another screen
  // (the history, the back button) is not the opening of a new page, and must not put the cursor in the title again.
  const newPageRef = useRef(page.title === '' && (location.state as { newPage?: boolean } | null)?.newPage === true);
  useEffect(() => {
    if ((location.state as { newPage?: boolean } | null)?.newPage === true) navigate('.', { replace: true, state: null });
  }, []);
  const client = useQueryClient();
  const beginRename = useRef(latestOnly()).current;
  // The key of the location now, or null once this page has gone from the screen.
  const hereKey = useRef<string | null>(location.key);
  hereKey.current = location.key;
  useEffect(() => {
    hereKey.current = location.key;
    return () => {
      hereKey.current = null;
    };
  });
  const treeActions = useTreeActions(session?.api ?? (null as never), page.collectionId);
  /**
   * Saves the title through the rename the tree uses (the tree shows it at once), then shows it here and in the address (the slug of the address follows the title; an old address still finds the page by
   * the id at its end); false when the server refused it. The page is not rebuilt for it: the main area is keyed by the page's id, not by its address.
   */
  const saveTitle = async (title: string): Promise<boolean> => {
    const pressedAt = hereKey.current;
    const isLatest = beginRename();
    const outcome = await treeActions.rename(page.id, title);
    const verdict = verdictOf(isLatest, outcome.ok); // a later rename began meanwhile: its title and its address are the ones to show, whichever answer came last
    let moved = false;
    if (verdict === 'applied') {
      // The page as the cache has it now (a re-read may have come in while the rename was on its way), with only the title changed.
      client.setQueryData<PageResult>(queryKey('GET', '/v1/pages/by-url-id/{urlId}', { urlId: page.urlId }), (cached) => titled(cached, title));
      // The address is changed only if the person is still on this page, where they pressed Enter (the key of the location; none once the page is gone): they may have gone elsewhere meanwhile.
      moved = hereKey.current === pressedAt;
      if (moved) navigate(pagePath(title, page.urlId), { replace: true, state: location.state });
    }
    log('info', 'web.title_rename_settled', { page: page.id, verdict, moved }); // what was decided, for the log and for a test to wait on
    return verdict !== 'refused';
  };

  useEffect(() => editableRef.current(!readOnly && state.stopped === null), [readOnly, state.stopped]);

  useEffect(() => {
    const element = rootRef.current;
    if (element === null || session === null) return;
    const disposeAttachments = provideAttachments(element, { fetchUrls: signedUrlsFrom(clientOf(session)), pageId: page.id, api: clientOf(session), uploadApi: quietApiOf(session), limits: lazyLimits(quietApiOf(session) ?? clientOf(session)), notify });
    let cancelled = false;
    let live: MountedEditor | null = null;
    let saved: MountedEditor | null = null;
    let liveGeneration = 0;
    let seenGeneration = 0;
    let starting = false;
    let attempts = 0;
    let savedToken = 0;
    const editable = (): boolean => !(permissionRef.current || manager.state().readOnly || manager.state().stopped !== null);
    const manager: ConnectionManager = new ConnectionManager({
      auth: { getToken: () => session.auth.getToken(), refresh: () => session.auth.refresh(), signOut: () => session.auth.signOut('expired') },
      clientVersion: CLIENT_VERSION,
      createSession: (token) => engine.createSession({ url: session.collabUrl, pageId: page.id, token }),
      captureCopy: () => live?.markdown() ?? null,
      log: (event, fields) => log('warn', event, fields),
      onLongOffline: () => void (session.apiUrl === undefined ? undefined : recheckMinClientVersion({ apiUrl: session.apiUrl })),
    });

    const showSaved = (): void => {
      void (async () => {
        if (cancelled || live !== null || saved !== null) return;
        // Only the newest request may show its text: a late answer to an older one (or one that began before a live editor did) is dropped.
        const token = (savedToken += 1);
        // The read happens outside the queue: a slow export must not hold up the live editor, which only needs the queue for its DOM steps.
        const { data, response } = await session.api.GET('/v1/pages/{id}/markdown' as never, { params: { path: { id: page.id } }, parseAs: 'text' } as never);
        if (cancelled || !response.ok || token !== savedToken) return;
        await queue(element, async () => {
          if (cancelled || token !== savedToken || live !== null || saved !== null) return; // a live editor that mounted first wins
          saved = await engine.mountReadOnly(element, typeof data === 'string' ? data : '');
          setStale(staleRef.current || response.headers.get('X-Grimoire-Markdown-Stale') === 'true');
          setShowingSaved(true);
        });
      })().catch(() => log('warn', 'web.page_saved_view_failed', { page: page.id }));
    };

    const goLive = (generation: number): void => {
      starting = true;
      savedToken += 1; // a saved text still on its way is not wanted any more
      const attempt = (attempts += 1);
      // Only the newest attempt may say the building is over: an older one that gives up must not let a second build start beside the newer one.
      const finished = (): void => {
        if (attempt === attempts) starting = false;
      };
      const synced = manager.currentSession();
      /** Still the document that synced, and still synced and running: otherwise an editor on it would take typing into a document that is not the page. */
      const current = (): boolean => !cancelled && manager.currentSession() === synced && manager.state().generation === generation && manager.state().phase === 'synced';
      void queue(element, async () => {
        if (cancelled) return;
        if (!current()) {
          finished();
          return;
        }
        await saved?.destroy();
        saved = null;
        setShowingSaved(false);
        if (synced === null) return;
        const mounted = await engine.mountLive({
          element,
          session: synced,
          editable: editable(),
          isCancelled: () => cancelled,
          presence: { userId: () => meRef.current, directory: sessionDirectory(session.api) },
        });
        if (mounted === null) return;
        if (!current()) {
          // The document was replaced, or the connection stopped, while the editor was being built: take it down again.
          await mounted.destroy();
          finished();
          if (!cancelled) showSaved();
          return;
        }
        live = mounted;
        liveGeneration = generation;
        editableRef.current = (flag) => live?.setEditable(flag);
        live.setEditable(editable()); // a read-only signal that came while the editor was being built applies now
        setLiveReady(true);
        const handed = restoreRef.current;
        if (handed !== null) {
          restoreRef.current = null;
          live.applyMarkdown(handed);
          navigate('.', { replace: true, state: null });
        }
      }).catch(() => {
        log('warn', 'web.page_mount_failed', { page: page.id });
        // The saved view was taken down for the live editor, which could not be built: the page stays readable.
        finished();
        if (!cancelled) showSaved();
      });
    };

    const unsubscribe = manager.subscribe((next) => {
      setState(next);
      if (cancelled) return;
      if (next.generation > seenGeneration) {
        // A new document: the person's access may have changed (that is usually why), so the page is read again.
        if (seenGeneration > 0) void replacedRef.current?.();
        seenGeneration = next.generation;
        starting = false; // a build still going is for the document that was replaced: it gives up on its own, and this one starts its own
      }
      if (live !== null && next.generation !== liveGeneration) {
        // The document under the editor was replaced: take the editor down and show the saved text until the new one has synced.
        const old = live;
        live = null;
        starting = false;
        setLiveReady(false);
        void queue(element, async () => void (await old.destroy())).then(showSaved);
      }
      if (next.phase === 'synced' && live === null && !starting) goLive(next.generation);
    });
    managerRef.current = manager;
    manager.start();
    // A hidden tab lets go of its connection after a while (the server's budget is per connection) and takes it up again when it is shown.
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
    const onVisibility = (): void => {
      if (hiddenTimer !== null) clearTimeout(hiddenTimer);
      hiddenTimer = null;
      if (document.visibilityState === 'hidden') hiddenTimer = setTimeout(() => manager.suspend(), session.hiddenDisconnectMs ?? DEFAULT_HIDDEN_DISCONNECT_MS);
      else manager.resume();
    };
    // The browser's word on the network: a socket can stay open long after the connection is gone, so the editor does not wait for it to close.
    const onOffline = (): void => manager.networkLost();
    const onOnline = (): void => manager.networkBack();
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    if (!navigator.onLine) onOffline();
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState === 'hidden') onVisibility(); // a page opened in a background tab starts its clock at once
    showSaved();

    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      if (hiddenTimer !== null) clearTimeout(hiddenTimer);
      managerRef.current = null;
      cancelled = true;
      unsubscribe();
      disposeAttachments();
      manager.stop(); // provider, then document
      editableRef.current = () => undefined;
      void queue(element, async () => {
        await live?.destroy();
        await saved?.destroy();
        live = null;
        saved = null;
      });
    };
    // The session and the page are what an editor belongs to; the read-only flag is applied by the effect above.
  }, [page.id, session, engine]);

  const collab: CollabState = state.stopped !== null ? 'stopped' : state.suspended ? 'disconnected' : state.offline ? 'offline' : liveReady && state.phase === 'synced' ? 'synced' : 'connecting';

  // The server says the page is not there any more (removed while it was open): the not-found screen, with the editor out of sight and nothing more sent.
  if (state.stopped === 'not-found') return <PageNotFound />;

  return (
    <div className="page-layout">
      <article className="page">
        <header className="page-head">
          <PageTitle title={page.title} editable={!readOnly && session !== null} startEditing={newPageRef.current} onSave={saveTitle} />
          {readOnly ? <span className="page-readonly">Read only</span> : null}
          <PageMenu triggerRef={moreRef} onHistory={() => navigate(`${pagePath(page.title, page.urlId)}/history`)} onReset={me.data?.role === 'admin' && session !== null ? () => setResetOpen(true) : undefined} />
        </header>
        <StatusLine state={{ ...state, readOnly }} collab={collab} onRetry={() => managerRef.current?.retry()} />
        {state.copy !== null ? <ResetNotice key={state.copy} copy={state.copy} title={page.title} onDismiss={() => managerRef.current?.dismissCopy()} /> : null}
        {state.banner !== null ? <p className="page-banner">{state.banner}</p> : null}
        {showingSaved && stale ? <p className="page-stale">{STALE_TEXT}</p> : null}
        <div ref={rootRef} className="page-editor page-text" data-collab-state={collab} data-testid="editor-root" />
        {me.data?.role === 'admin' && session !== null ? <ResetPageDialog api={session.api} page={{ id: page.id, title: page.title }} open={resetOpen} onOpenChange={setResetOpen} returnFocus={moreRef} /> : null}
      </article>
      <div className="page-margin">
        <Outline />
      </div>
    </div>
  );
}
