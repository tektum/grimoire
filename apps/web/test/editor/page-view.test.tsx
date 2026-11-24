import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from '../../src/auth';
import { SessionContext, type Session as AppSession } from '../../src/auth/session';
import type { MountedEditor } from '../../src/editor/core/mount';
import { PageView, STALE_TEXT, type PageMeta } from '../../src/screens/page/PageView';
import type { Engine } from '../../src/screens/page/engine';
import { FakeClock, FakeDoc, FakeProvider } from './support';

afterEach(cleanup);

const page = (over: Partial<PageMeta> = {}): PageMeta =>
  ({ id: '11111111-1111-4111-8111-111111111111', title: 'Plan', urlId: 'abc', myPermission: 'read-write', markdownStale: false, stateEpoch: 1, breadcrumb: [], ...over }) as unknown as PageMeta;

interface Live {
  editable: boolean;
  applied: string[];
  destroyed: boolean;
  session: unknown;
}
/** An engine whose editors are plain elements: a real editor needs a browser (the end-to-end specs cover it). */
function fakeEngine() {
  const clock = new FakeClock();
  const sessions: { provider: FakeProvider; doc: FakeDoc }[] = [];
  const lives: Live[] = [];
  const events: string[] = [];
  const editorIn = (element: HTMLElement, text: string, editable: boolean): { dom: HTMLElement; wrap: (state: Live | null) => MountedEditor } => {
    const dom = element.appendChild(document.createElement('div'));
    dom.className = 'ProseMirror';
    dom.setAttribute('contenteditable', String(editable));
    dom.textContent = text;
    return {
      dom,
      wrap: (state) => ({
        setEditable: (flag) => {
          dom.setAttribute('contenteditable', String(flag));
          if (state) state.editable = flag;
        },
        markdown: () => `copy of ${dom.textContent}`,
        applyMarkdown: (md) => void state?.applied.push(md),
        destroy: async () => {
          dom.remove();
          if (state) state.destroyed = true;
          events.push(state ? 'live-destroyed' : 'saved-destroyed');
        },
      }),
    };
  };
  const engine: Engine = {
    createSession: ({ token }) => {
      const provider = new FakeProvider(token, clock);
      const doc = new FakeDoc();
      sessions.push({ provider, doc });
      return { provider, doc };
    },
    mountReadOnly: async (element, markdown) => editorIn(element, markdown, false).wrap(null),
    mountLive: async ({ element, session, editable, isCancelled }) => {
      const state: Live = { editable, applied: [], destroyed: false, session };
      const made = editorIn(element, 'live', editable);
      await Promise.resolve();
      if (isCancelled()) {
        made.dom.remove();
        events.push('live-cancelled');
        return null;
      }
      lives.push(state);
      return made.wrap(state);
    },
  };
  return { engine, sessions, lives, events, clock };
}

function mountPage(
  options: {
    page?: PageMeta;
    strict?: boolean;
    state?: unknown;
    markdown?: string;
    staleHeader?: boolean;
    markdownStatus?: number;
    markdownGate?: Promise<void>;
    onReplaced?: () => void;
    engine?: Partial<Engine> | ((base: Engine) => Partial<Engine>);
    authOver?: Partial<Auth>;
  } = {},
) {
  const fake = fakeEngine();
  const auth = { getToken: async () => 'token', refresh: async () => true, signOut: async () => undefined, ...options.authOver } as unknown as Auth;
  const api = {
    GET: vi.fn(async () => {
      if (options.markdownGate) await options.markdownGate;
      return {
        data: options.markdown ?? 'Saved text',
        response: new Response('', { status: options.markdownStatus ?? 200, headers: options.staleHeader ? { 'X-Grimoire-Markdown-Stale': 'true' } : {} }),
      };
    }),
  } as unknown as AppSession['api'];
  const value: AppSession = { auth, api, collabUrl: 'ws://collab.test' };
  const setPage: { current: (p: PageMeta) => void } = { current: () => undefined };
  const engine = { ...fake.engine, ...(typeof options.engine === 'function' ? options.engine(fake.engine) : options.engine) };
  const Host = () => {
    const [current, set] = useState(options.page ?? page());
    setPage.current = set;
    return <PageView page={current} engine={engine} {...(options.onReplaced === undefined ? {} : { onReplaced: options.onReplaced })} />;
  };
  const router = createMemoryRouter([{ path: '/', element: <Host /> }], { initialEntries: [{ pathname: '/', state: options.state }] });
  const tree = (
    <SessionContext.Provider value={value}>
      <RouterProvider router={router} />
    </SessionContext.Provider>
  );
  const view = render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
  const root = () => screen.getByTestId('editor-root');
  const synced = (index = fake.sessions.length - 1) => act(async () => void fake.sessions[index]!.provider.succeed(1));
  return { ...fake, api, root, synced, view, setPage: (p: PageMeta) => act(async () => setPage.current(p)) };
}

const waitSaved = () => waitFor(() => expect(document.querySelector('.ProseMirror[contenteditable="false"]')).not.toBeNull());

describe('the page screen', () => {
  it('shows the saved text read-only first, then the live editor once synced, and says which at each step on the editor root', async () => {
    const t = mountPage();
    await waitSaved();
    expect(t.root().textContent).toBe('Saved text');
    expect(t.root().getAttribute('data-collab-state')).toBe('connecting');
    await t.synced();
    await waitFor(() => expect(t.root().getAttribute('data-collab-state')).toBe('synced'));
    expect(t.root().querySelectorAll('.ProseMirror')).toHaveLength(1);
    expect(t.root().textContent).toBe('live');
    expect(t.events).toContain('saved-destroyed');
    expect((t.lives[0]!.session as { provider: unknown }).provider).toBe(t.sessions[0]!.provider);
  });

  it('under strict mode builds one live editor for one document: the first provider and document are destroyed, and exactly one editor is left', async () => {
    const t = mountPage({ strict: true });
    await waitFor(() => expect(t.sessions.length).toBe(2));
    expect(t.sessions[0]!.provider.destroyed).toBe(true);
    expect(t.sessions[0]!.doc.destroyed).toBe(true);
    expect(t.sessions[1]!.provider.destroyed).toBe(false);
    await t.synced(1);
    await waitFor(() => expect(t.root().getAttribute('data-collab-state')).toBe('synced'));
    expect(t.root().querySelectorAll('.ProseMirror')).toHaveLength(1);
    expect(t.lives).toHaveLength(1);
    expect((t.lives[0]!.session as { provider: unknown }).provider).toBe(t.sessions[1]!.provider);
  });

  it('shows the Read only label and builds a non-editable editor for a read-only person, and neither for a writer', async () => {
    const reader = mountPage({ page: page({ myPermission: 'read-only' }) });
    await reader.synced();
    await waitFor(() => expect(reader.lives).toHaveLength(1));
    expect(reader.lives[0]!.editable).toBe(false);
    expect(screen.getByText('Read only')).toBeTruthy();
    cleanup();
    const writer = mountPage();
    await writer.synced();
    await waitFor(() => expect(writer.lives).toHaveLength(1));
    expect(writer.lives[0]!.editable).toBe(true);
    expect(screen.queryByText('Read only')).toBeNull();
  });

  it('turns editing off, with the label, when the server says the page is too large, without rebuilding the editor', async () => {
    const t = mountPage();
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    await act(async () => void t.sessions[0]!.provider.stateless({ kind: 'refusal', code: 'state-cap' }));
    await waitFor(() => expect(t.lives[0]!.editable).toBe(false));
    expect(screen.getByText('Read only')).toBeTruthy();
    expect(t.lives).toHaveLength(1);
  });

  it('says the saved text may be behind when the page is marked stale, by the page or by the export header, in the first view only', async () => {
    for (const make of [() => mountPage({ page: page({ markdownStale: true }) }), () => mountPage({ staleHeader: true })]) {
      const t = make();
      await waitSaved();
      await screen.findByText(STALE_TEXT); // the label follows the saved text by a step
      await t.synced();
      await waitFor(() => expect(screen.queryByText(STALE_TEXT)).toBeNull());
      cleanup();
    }
    cleanup();
    mountPage();
    await waitSaved();
    expect(screen.queryByText(STALE_TEXT)).toBeNull();
  });

  it('puts the status in the line under the title: Connecting, then Live, then the offline text', async () => {
    const t = mountPage();
    expect(screen.getByRole('status').textContent).toBe('Connecting…');
    await t.synced();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Live'));
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('synced');
  });

  it('destroys the provider, the document and the editor when the screen goes away', async () => {
    const t = mountPage();
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    t.view.unmount();
    await waitFor(() => expect(t.lives[0]!.destroyed).toBe(true));
    expect(t.sessions[0]!.provider.destroyed).toBe(true);
    expect(t.sessions[0]!.doc.destroyed).toBe(true);
  });

  it('hands a restored text to the editor once it is live, and only once', async () => {
    const t = mountPage({ state: { restoreMarkdown: '# Older version' } });
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    await waitFor(() => expect(t.lives[0]!.applied).toEqual(['# Older version']));
  });

  it('when the document under the editor is replaced, takes the editor down, shows the saved text, and mounts a new editor on the new document', async () => {
    const t = mountPage();
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    await act(async () => void t.sessions[0]!.provider.close(4205, 'access-changed'));
    await waitFor(() => expect(t.lives[0]!.destroyed).toBe(true));
    await waitFor(() => expect(t.sessions).toHaveLength(2));
    await waitSaved();
    expect(t.root().getAttribute('data-collab-state')).toBe('connecting');
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(2));
    expect((t.lives[1]!.session as { provider: unknown }).provider).toBe(t.sessions[1]!.provider);
    expect(t.root().querySelectorAll('.ProseMirror')).toHaveLength(1);
  });

  it('shows a stopped state on the root when the connection manager stops', async () => {
    const t = mountPage();
    await act(async () => void t.sessions[0]!.provider.refuse('forbidden'));
    await waitFor(() => expect(t.root().getAttribute('data-collab-state')).toBe('stopped'));
    expect(screen.getByRole('status').textContent).toBe('You no longer have access to this page');
  });

  it('shows no saved text when it cannot be fetched, and still goes live', async () => {
    const t = mountPage({ markdownStatus: 500 });
    await waitFor(() => expect(t.api.GET).toHaveBeenCalled());
    await t.synced();
    await waitFor(() => expect(t.root().getAttribute('data-collab-state')).toBe('synced'));
    expect(t.root().textContent).toBe('live');
  });

  it('keeps going when the saved view or the live editor cannot be built: the connection state still shows', async () => {
    const t = mountPage({
      engine: {
        mountReadOnly: async () => Promise.reject(new Error('no saved view')),
        mountLive: async () => Promise.reject(new Error('no editor')),
      },
    });
    await t.synced();
    await waitFor(() => expect(t.api.GET).toHaveBeenCalled());
    expect(t.root().getAttribute('data-collab-state')).toBe('connecting'); // never claims synced without an editor
    expect(screen.getByRole('status').textContent).toBe('Connecting…');
  });

  it('asks the session for a token and a refresh, and signs out, through the connection manager', async () => {
    const refresh = vi.fn(async () => false);
    const signOut = vi.fn(async () => undefined);
    const t = mountPage({ authOver: { refresh, signOut } });
    await act(async () => void t.sessions[0]!.provider.refuse('invalid-token'));
    await waitFor(() => expect(signOut).toHaveBeenCalledWith('expired'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('takes the Markdown copy from the live editor before it is destroyed on a reset', async () => {
    const t = mountPage();
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    await act(async () => void t.sessions[0]!.provider.close(4409, 'stale-epoch'));
    await waitFor(() => expect(t.sessions).toHaveLength(2));
    expect(t.lives[0]!.destroyed).toBe(true);
  });

  it('logs a presence violation by name, without a payload', async () => {
    const t = mountPage();
    await act(async () => void t.sessions[0]!.provider.stateless({ kind: 'refusal', code: 'presence-violation' }));
    await waitFor(() => expect(t.root().getAttribute('data-collab-state')).toBe('connecting'));
  });

  it('says Read only once: as the label, not also as the status line', async () => {
    const t = mountPage({ page: page({ myPermission: 'read-only' }) });
    await t.synced();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Live'));
    act(() => void t.sessions[0]!.provider.emit({ type: 'authenticated', scope: 'readonly' }));
    expect(screen.getAllByText('Read only')).toHaveLength(1);
  });

  it('sets the text in the reading column: the page-text class (the page font and the measure) is on the editor root', async () => {
    const t = mountPage();
    expect(t.root().classList.contains('page-text')).toBe(true);
  });

  it('does not leave an editor on a document that was replaced while the editor was being built: it is taken down and the saved text shows', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => void (release = resolve));
    const t = mountPage({ engine: (base) => ({ mountLive: async (o) => (await gate, base.mountLive(o)) }) });
    await waitSaved();
    await t.synced();
    await act(async () => void t.sessions[0]!.provider.close(4205, 'access-changed')); // a new document, while the editor of the old one is still being built
    await waitFor(() => expect(t.sessions).toHaveLength(2));
    release();
    await waitFor(() => expect(t.lives.length === 0 || t.lives.every((l) => l.destroyed)).toBe(true));
    await waitSaved();
    expect(t.root().getAttribute('data-collab-state')).toBe('connecting');
    expect(t.root().querySelectorAll('.ProseMirror')).toHaveLength(1);
    expect(t.root().querySelector('.ProseMirror')!.getAttribute('contenteditable')).toBe('false');
  });

  it('turns editing off when the connection stops: nothing typed after "no longer have access" goes into a document that will never be sent', async () => {
    const t = mountPage();
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    expect(t.lives[0]!.editable).toBe(true);
    await act(async () => void t.sessions[0]!.provider.refuse('forbidden'));
    await waitFor(() => expect(t.lives[0]!.editable).toBe(false));
  });

  it('builds a live editor that stops before it is bound: no editor, the page stays readable on its saved text', async () => {
    const t = mountPage({ engine: { mountLive: async () => Promise.reject(new Error('no editor')) } });
    await waitSaved();
    await t.synced();
    await waitFor(() => expect(t.events).toContain('saved-destroyed')); // taken down for the live editor ...
    await waitSaved(); // ... and back, because the live editor could not be built
    expect(t.root().textContent).toBe('Saved text');
    expect(t.root().getAttribute('data-collab-state')).toBe('connecting');
  });

  it('does not build an editor on a document that was replaced before the build began, and builds one on the new document when that has synced', async () => {
    const t = mountPage();
    await waitSaved();
    await act(async () => {
      t.sessions[0]!.provider.succeed(1);
      t.sessions[0]!.provider.close(4205, 'access-changed'); // replaced in the same breath as the sync
    });
    await waitFor(() => expect(t.sessions).toHaveLength(2));
    expect(t.lives).toHaveLength(0);
    await t.synced(1);
    await waitFor(() => expect(t.lives).toHaveLength(1));
    expect((t.lives[0]!.session as { provider: unknown }).provider).toBe(t.sessions[1]!.provider);
  });

  it('a reader who is given write access can type in the new document without a reload: the page is read again, and what it says now decides', async () => {
    const onReplaced = vi.fn();
    const t = mountPage({ page: page({ myPermission: 'read-only' }), onReplaced });
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    expect(t.lives[0]!.editable).toBe(false);
    expect(onReplaced).not.toHaveBeenCalled();
    await act(async () => void t.sessions[0]!.provider.close(4205, 'access-changed'));
    await waitFor(() => expect(onReplaced).toHaveBeenCalledTimes(1));
    await t.setPage(page({ myPermission: 'read-write' })); // the page read again
    await t.synced(1);
    await waitFor(() => expect(t.lives).toHaveLength(2));
    expect(t.lives[1]!.editable).toBe(true);
    expect(screen.queryByText('Read only')).toBeNull();
  });

  it('an older build that gives up does not let a second build start beside the newer one: one editor stays bound, even when the state changes meanwhile', async () => {
    const gates: (() => void)[] = [];
    let calls = 0;
    const t = mountPage({
      engine: (base) => ({
        mountLive: async (o) => {
          calls += 1;
          await new Promise<void>((resolve) => void gates.push(resolve));
          return base.mountLive(o);
        },
      }),
    });
    await waitSaved();
    await t.synced(); // generation 1 starts to build, and waits
    await waitFor(() => expect(gates).toHaveLength(1));
    await act(async () => void t.sessions[0]!.provider.close(4205, 'access-changed')); // generation 2
    await waitFor(() => expect(t.sessions).toHaveLength(2));
    await t.synced(1); // generation 2 syncs: its build waits behind the first
    gates[0]!(); // the first finishes, finds its document replaced, and gives up
    await waitFor(() => expect(gates).toHaveLength(2)); // the second build is under way
    await act(async () => void t.sessions[1]!.provider.stateless({ kind: 'warning', code: 'state-warning' })); // a state change while it is
    gates[1]!();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    expect(calls).toBe(2);
    expect(t.root().querySelectorAll('.ProseMirror')).toHaveLength(1);
  });

  it('goes live when the page has synced even if the saved text is slow to arrive, and the late text is dropped, not shown over the live editor', async () => {
    let arrive: () => void = () => undefined;
    const markdownGate = new Promise<void>((resolve) => void (arrive = resolve));
    const t = mountPage({ markdownGate, markdown: 'Late saved text' });
    await waitFor(() => expect(t.api.GET).toHaveBeenCalled());
    await t.synced();
    await waitFor(() => expect(t.root().getAttribute('data-collab-state')).toBe('synced'));
    expect(t.root().textContent).toBe('live');
    arrive(); // the saved text arrives after the live editor is up
    await (t.api.GET as unknown as { mock: { results: { value: Promise<unknown> }[] } }).mock.results[0]!.value; // the request has settled: that is the signal
    await act(async () => undefined); // and the few steps that follow it have run
    expect(t.root().textContent).toBe('live');
    expect(t.root().querySelectorAll('.ProseMirror')).toHaveLength(1);
    expect(t.events).not.toContain('saved-destroyed'); // it was never mounted
  });

  it('the stale warning follows the page as it is read again: a document replaced after the page stopped being stale shows no warning', async () => {
    const t = mountPage({ page: page({ markdownStale: true }) });
    await waitSaved();
    await screen.findByText(STALE_TEXT); // the label follows the saved text by a step
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    await t.setPage(page({ markdownStale: false })); // the page read again
    await act(async () => void t.sessions[0]!.provider.close(4205, 'access-changed'));
    await waitFor(() => expect(t.sessions).toHaveLength(2));
    await waitSaved();
    expect(screen.queryByText(STALE_TEXT)).toBeNull();
  });

  it('a read-only signal that arrives while the live editor is being built applies to it once it exists', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => void (release = resolve));
    const t = mountPage({ engine: (base) => ({ mountLive: async (o) => (await gate, base.mountLive(o)) }) });
    await waitSaved();
    await t.synced();
    await act(async () => void t.sessions[0]!.provider.stateless({ kind: 'refusal', code: 'state-cap' })); // too large, before the editor exists
    release();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    expect(t.lives[0]!.editable).toBe(false);
  });

  it('a connection that drops and syncs again while the live editor is being built does not start a second build', async () => {
    const gates: (() => void)[] = [];
    let calls = 0;
    const t = mountPage({
      engine: (base) => ({
        mountLive: async (o) => {
          calls += 1;
          await new Promise<void>((resolve) => void gates.push(resolve));
          return base.mountLive(o);
        },
      }),
    });
    await waitSaved();
    await t.synced();
    await waitFor(() => expect(gates).toHaveLength(1));
    await act(async () => void t.sessions[0]!.provider.close(1001)); // a plain drop: same session, same document
    await t.synced(); // and it syncs again before the build is done
    gates[0]!();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    await act(async () => undefined);
    expect(calls).toBe(1);
    expect(t.root().querySelectorAll('.ProseMirror')).toHaveLength(1);
  });
});
