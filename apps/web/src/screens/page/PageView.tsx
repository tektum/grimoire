import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ConnectionManager, type ConnectionState } from '../../editor/core/connection';
import type { MountedEditor } from '../../editor/core/mount';
import { log } from '../../logging';
import { Outline } from '../../outline';
import { useSession } from '../../auth/session';
import { CLIENT_VERSION } from '../../version';
import type { components } from '@tektum/grimoire-api-client';
import { realEngine, type Engine } from './engine';
import './page.css';

export type PageMeta = components['schemas']['Page'];
export type CollabState = 'connecting' | 'synced' | 'offline' | 'stopped';

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

const IDLE: ConnectionState = { phase: 'idle', stopped: null, text: null, notice: null, banner: null, readOnly: false, offline: false, copy: null, generation: 0 };

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
  const permissionRef = useRef(permissionReadOnly);
  permissionRef.current = permissionReadOnly;
  const replacedRef = useRef(onReplaced);
  replacedRef.current = onReplaced;
  const readOnly = permissionReadOnly || state.readOnly;
  const restore = (location.state as { restoreMarkdown?: unknown } | null)?.restoreMarkdown;
  const restoreRef = useRef(typeof restore === 'string' ? restore : null);

  useEffect(() => editableRef.current(!readOnly && state.stopped === null), [readOnly, state.stopped]);

  useEffect(() => {
    const element = rootRef.current;
    if (element === null || session === null) return;
    let cancelled = false;
    let live: MountedEditor | null = null;
    let saved: MountedEditor | null = null;
    let liveGeneration = 0;
    let seenGeneration = 0;
    let starting = false;
    const editable = (): boolean => !(permissionRef.current || manager.state().readOnly || manager.state().stopped !== null);
    const manager: ConnectionManager = new ConnectionManager({
      auth: { getToken: () => session.auth.getToken(), refresh: () => session.auth.refresh(), signOut: () => session.auth.signOut('expired') },
      clientVersion: CLIENT_VERSION,
      createSession: (token) => engine.createSession({ url: session.collabUrl, pageId: page.id, token }),
      captureCopy: () => live?.markdown() ?? null,
      log: (event, fields) => log('warn', event, fields),
    });

    const showSaved = (): void => {
      void queue(element, async () => {
        if (cancelled || live !== null || saved !== null) return;
        const { data, response } = await session.api.GET('/v1/pages/{id}/markdown' as never, { params: { path: { id: page.id } }, parseAs: 'text' } as never);
        if (cancelled || live !== null || saved !== null || !response.ok) return;
        saved = await engine.mountReadOnly(element, typeof data === 'string' ? data : '');
        setStale(page.markdownStale || response.headers.get('X-Grimoire-Markdown-Stale') === 'true');
        setShowingSaved(true);
      }).catch(() => log('warn', 'web.page_saved_view_failed', { page: page.id }));
    };

    const goLive = (generation: number): void => {
      starting = true;
      const synced = manager.currentSession();
      /** Still the document that synced, and still synced and running: otherwise an editor on it would take typing into a document that is not the page. */
      const current = (): boolean => !cancelled && manager.currentSession() === synced && manager.state().generation === generation && manager.state().phase === 'synced';
      void queue(element, async () => {
        if (cancelled) return;
        if (!current()) {
          starting = false;
          return;
        }
        await saved?.destroy();
        saved = null;
        setShowingSaved(false);
        if (synced === null) return;
        const mounted = await engine.mountLive({ element, session: synced, editable: editable(), isCancelled: () => cancelled });
        if (mounted === null) return;
        if (!current()) {
          // The document was replaced, or the connection stopped, while the editor was being built: take it down again.
          await mounted.destroy();
          starting = false;
          if (!cancelled) showSaved();
          return;
        }
        live = mounted;
        liveGeneration = generation;
        editableRef.current = (flag) => live?.setEditable(flag);
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
        starting = false;
        if (!cancelled) showSaved();
      });
    };

    const unsubscribe = manager.subscribe((next) => {
      setState(next);
      if (cancelled) return;
      if (next.generation > seenGeneration) {
        // A new document: the person's access may have changed (that is usually why), so the page is read again.
        if (seenGeneration > 0) replacedRef.current?.();
        seenGeneration = next.generation;
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
      if (next.phase !== 'synced' && starting && live === null) starting = false;
    });
    manager.start();
    showSaved();

    return () => {
      cancelled = true;
      unsubscribe();
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

  const collab: CollabState = state.stopped !== null ? 'stopped' : state.offline ? 'offline' : liveReady && state.phase === 'synced' ? 'synced' : 'connecting';
  // The 'Read only' text of the scope is the label beside the title, not a second line of status.
  const status = (state.text === 'Read only' ? null : state.text) ?? (collab === 'synced' ? 'Live' : collab === 'connecting' ? 'Connecting…' : null);

  return (
    <div className="page-layout">
      <article className="page">
        <header className="page-head">
          <h1 id="screen-title">{page.title === '' ? 'Untitled' : page.title}</h1>
          {readOnly ? <span className="page-readonly">Read only</span> : null}
        </header>
        <p className="page-status" role="status" data-state={collab}>
          {status}
        </p>
        {state.banner !== null ? <p className="page-banner">{state.banner}</p> : null}
        {showingSaved && stale ? <p className="page-stale">{STALE_TEXT}</p> : null}
        <div ref={rootRef} className="page-editor page-text" data-collab-state={collab} data-testid="editor-root" />
      </article>
      <div className="page-margin">
        <Outline />
      </div>
    </div>
  );
}
