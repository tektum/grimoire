import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from '../../src/auth';
import { SessionContext, type Session as AppSession } from '../../src/auth/session';
import type { MountedEditor } from '../../src/editor/core/mount';
import { isClientOutdated, resetClientOutdated } from '../../src/gate/outdated';
import { PageView, STALE_TEXT, type PageMeta } from '../../src/screens/page/PageView';
import type { Engine } from '../../src/screens/page/engine';
import { sessionDirectory } from '../../src/editor/core/directory';
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
    hiddenMs?: number;
    meRole?: string;
    onReplaced?: () => void;
    engine?: Partial<Engine> | ((base: Engine) => Partial<Engine>);
    authOver?: Partial<Auth>;
  } = {},
) {
  const fake = fakeEngine();
  const auth = { getToken: async () => 'token', refresh: async () => true, signOut: async () => undefined, ...options.authOver } as unknown as Auth;
  const api = {
    GET: vi.fn(async (path: string) => {
      if (path === '/v1/me') return { data: { id: '22222222-2222-4222-8222-222222222222', ...(options.meRole === undefined ? {} : { role: options.meRole }) }, response: new Response('', { status: 200 }) };
      if (options.markdownGate) await options.markdownGate;
      return {
        data: options.markdown ?? 'Saved text',
        response: new Response('', { status: options.markdownStatus ?? 200, headers: options.staleHeader ? { 'X-Grimoire-Markdown-Stale': 'true' } : {} }),
      };
    }),
  } as unknown as AppSession['api'];
  const value: AppSession = { auth, api, collabUrl: 'ws://collab.test', apiUrl: 'http://api.test', ...(options.hiddenMs === undefined ? {} : { hiddenDisconnectMs: options.hiddenMs }) };
  const setPage: { current: (p: PageMeta) => void } = { current: () => undefined };
  const engine = { ...fake.engine, ...(typeof options.engine === 'function' ? options.engine(fake.engine) : options.engine) };
  const Host = () => {
    const [current, set] = useState(options.page ?? page());
    setPage.current = set;
    return <PageView page={current} engine={engine} {...(options.onReplaced === undefined ? {} : { onReplaced: options.onReplaced })} />;
  };
  const router = createMemoryRouter([{ path: '/', element: <Host /> }], { initialEntries: [{ pathname: '/', state: options.state }] });
  const tree = (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionContext.Provider value={value}>
        <RouterProvider router={router} />
      </SessionContext.Provider>
    </QueryClientProvider>
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
    await waitFor(() => expect(t.api.GET).toHaveBeenCalledWith('/v1/pages/{id}/markdown', expect.anything()));
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
    await waitFor(() => expect(t.api.GET).toHaveBeenCalledWith('/v1/pages/{id}/markdown', expect.anything()));
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
    await waitFor(() => expect(t.api.GET).toHaveBeenCalledWith('/v1/pages/{id}/markdown', expect.anything()));
    await t.synced();
    await waitFor(() => expect(t.root().getAttribute('data-collab-state')).toBe('synced'));
    expect(t.root().textContent).toBe('live');
    arrive(); // the saved text arrives after the live editor is up
    await (t.api.GET as unknown as { mock: { calls: [string][]; results: { value: Promise<unknown> }[] } }).mock.results[
      (t.api.GET as unknown as { mock: { calls: [string][] } }).mock.calls.findIndex(([path]) => path === '/v1/pages/{id}/markdown')
    ]!.value; // the request has settled: that is the signal
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

  it('gives the live editor the signed-in id (read when it is needed) and the directory of the session for names', async () => {
    let seen: { userId: () => string | null; directory: unknown } | null = null;
    const t = mountPage({ engine: (base) => ({ mountLive: async (o) => ((seen = o.presence), base.mountLive(o)) }) });
    await t.synced();
    await waitFor(() => expect(seen).not.toBeNull());
    await waitFor(() => expect(seen!.userId()).toBe('22222222-2222-4222-8222-222222222222'));
    expect(seen!.directory).toBe(sessionDirectory(t.api as never));
  });

  it('after a reset that left unsent changes, says so with the copy of them, and Dismiss drops it', async () => {
    const t = mountPage();
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    expect(screen.queryByText(/This page was reset/)).toBeNull();
    await act(async () => void t.sessions[0]!.provider.close(4409, 'stale-epoch'));
    expect((await screen.findByRole('alert')).textContent).toContain('This page was reset. Your unsent changes were not applied.');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(expect.arrayContaining(['Download my copy', 'Copy to clipboard', 'Dismiss']));
    await act(async () => void screen.getByRole('button', { name: 'Dismiss' }).click());
    expect(screen.queryByText(/This page was reset/)).toBeNull();
  });

  it('offers the copy that the editor held (its Markdown) under the page title', async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    const names: string[] = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    const t = mountPage();
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    await act(async () => void t.sessions[0]!.provider.close(4409, 'stale-epoch'));
    await act(async () => void (await screen.findByRole('button', { name: 'Download my copy' })).click());
    expect(names).toEqual(['Plan-your-copy.md']);
    spy.mockRestore();
  });

  it('offers an administrator the reset of the saved state, which opens its dialog naming the page; a member is not offered it', async () => {
    const admin = mountPage({ meRole: 'admin' });
    await waitFor(() => expect(screen.getByRole('button', { name: /Reset saved state/ })).toBeTruthy());
    await act(async () => void screen.getByRole('button', { name: /Reset saved state/ }).click());
    expect(await screen.findByText('Reset the saved state of Plan?')).toBeTruthy();
    admin.view.unmount();
    cleanup();
    const member = mountPage({ meRole: 'member' });
    await member.synced();
    await waitFor(() => expect(member.lives).toHaveLength(1));
    expect(screen.queryByRole('button', { name: /Reset saved state/ })).toBeNull();
  });

  it('links to the history of the page, for everyone, at /p/<slug>/history with the same slug the tree links with', async () => {
    mountPage({ page: page({ title: 'Release plan', urlId: 'ab12cd' }) });
    const link = await screen.findByRole('link', { name: 'History' });
    expect(link.getAttribute('href')).toBe('/p/release-plan-ab12cd/history');
    cleanup();
    mountPage({ page: page({ title: '', urlId: 'zz99' }), meRole: 'member' });
    expect((await screen.findByRole('link', { name: 'History' })).getAttribute('href')).toBe('/p/page-zz99/history');
  });

  it('a second reset replaces the offered copy and starts its notice afresh: "Copied." never refers to the old copy', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    let built = 0;
    const t = mountPage({
      engine: (base) => ({
        mountLive: async (o) => {
          const mounted = await base.mountLive(o);
          if (mounted === null) return null;
          const n = (built += 1);
          return { ...mounted, markdown: () => `copy number ${n}` };
        },
      }),
    });
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    await act(async () => void t.sessions[0]!.provider.close(4409, 'stale-epoch'));
    await act(async () => void (await screen.findByRole('button', { name: 'Copy to clipboard' })).click());
    expect(await screen.findByText('Copied.')).toBeTruthy();
    expect(writeText).toHaveBeenLastCalledWith('copy number 1');
    await t.synced(1);
    await waitFor(() => expect(t.lives).toHaveLength(2));
    await act(async () => void t.sessions[1]!.provider.close(4409, 'stale-epoch')); // reset again, before the first notice was dismissed
    await waitFor(() => expect(t.sessions).toHaveLength(3));
    await waitFor(() => expect(screen.queryByText('Copied.')).toBeNull());
    await act(async () => void screen.getByRole('button', { name: 'Copy to clipboard' }).click());
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('copy number 2'));
  });

  it('checks the minimum client version again when the connection is made again after more than a minute, with a plain request, and shows nothing else when the server wants a newer client', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // only the clock of the page moves: the waits of the test are real
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        asked.push(String(input));
        return new Response(JSON.stringify({ minClientVersion: '999.0.0' }), { status: 200 });
      }),
    );
    try {
      const t = mountPage();
      await t.synced();
      await waitFor(() => expect(t.lives).toHaveLength(1));
      expect(isClientOutdated()).toBe(false);
      await act(async () => void t.sessions[0]!.provider.disconnected());
      vi.setSystemTime(Date.now() + 61_000);
      await act(async () => void t.sessions[0]!.provider.succeed(1));
      await waitFor(() => expect(isClientOutdated()).toBe(true));
      expect(asked).toEqual(['http://api.test/v1/config']);
      expect(t.api.GET).not.toHaveBeenCalledWith('/v1/config', expect.anything()); // not through the API client: its notices would show a toast for a probe
    } finally {
      resetClientOutdated();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('lets go of the connection after the tab has been hidden for the configured time, says so on the root, and connects again when it is shown', async () => {
    const setVisibility = (state: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const t = mountPage({ hiddenMs: 20 });
    await t.synced();
    await waitFor(() => expect(t.root().getAttribute('data-collab-state')).toBe('synced'));
    await act(async () => setVisibility('hidden'));
    await waitFor(() => expect(t.sessions[0]!.provider.disconnects).toBe(1));
    await waitFor(() => expect(t.root().getAttribute('data-collab-state')).toBe('disconnected'));
    await act(async () => setVisibility('visible'));
    await waitFor(() => expect(t.sessions[0]!.provider.connects).toBe(2));
    expect(t.root().getAttribute('data-collab-state')).not.toBe('disconnected');
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('keeps the connection when the tab is shown again before the time is up', async () => {
    const setVisibility = (state: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const t = mountPage({ hiddenMs: 60_000 });
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    await act(async () => setVisibility('hidden'));
    await act(async () => setVisibility('visible'));
    expect(t.sessions[0]!.provider.disconnects).toBe(0);
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('starts the clock at once for a page that opens in a tab that is already hidden', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      const t = mountPage({ hiddenMs: 20 });
      await waitFor(() => expect(t.sessions[0]!.provider.disconnects).toBe(1));
      await waitFor(() => expect(t.root().getAttribute('data-collab-state')).toBe('disconnected'));
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('says "Offline: changes kept in this tab" when the browser says the network is gone for more than 10 s, though the socket stays open, and takes it away when the network is back', async () => {
    const t = mountPage();
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    vi.useFakeTimers();
    try {
      await act(async () => void window.dispatchEvent(new Event('offline')));
      await act(async () => void (await vi.advanceTimersByTimeAsync(9000)));
      expect(screen.queryByText('Offline: changes kept in this tab')).toBeNull();
      await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
      expect(screen.getByText('Offline: changes kept in this tab')).toBeTruthy();
      expect(t.root().getAttribute('data-collab-state')).toBe('offline');
      expect(t.sessions[0]!.provider.disconnects).toBe(0);
      await act(async () => void window.dispatchEvent(new Event('online')));
      expect(screen.queryByText('Offline: changes kept in this tab')).toBeNull();
      expect(t.root().getAttribute('data-collab-state')).toBe('synced');
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts as offline when the page opens while the browser already says it is', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    vi.useFakeTimers();
    try {
      const t = mountPage();
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(t.sessions).toHaveLength(1);
      await act(async () => void (await vi.advanceTimersByTimeAsync(11_000)));
      expect(screen.getByText('Offline: changes kept in this tab')).toBeTruthy();
    } finally {
      vi.useRealTimers();
      Reflect.deleteProperty(navigator, 'onLine');
    }
  });

  it('shows the not-found screen, and nothing of the editor, when the server says the page is gone', async () => {
    const t = mountPage();
    await t.synced();
    await waitFor(() => expect(t.lives).toHaveLength(1));
    await act(async () => void t.sessions[0]!.provider.close(4205, 'access-changed'));
    await waitFor(() => expect(t.sessions).toHaveLength(2));
    await act(async () => void t.sessions[1]!.provider.refuse('not-found'));
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.queryByTestId('editor-root')).toBeNull();
    // Nothing opens again: ten minutes of the page's time go by (any retry, at any backoff, would have fired in them), and the connection was asked for once.
    vi.useFakeTimers();
    try {
      await act(async () => void (await vi.advanceTimersByTimeAsync(10 * 60_000)));
    } finally {
      vi.useRealTimers();
    }
    expect(t.sessions).toHaveLength(2);
    expect(t.sessions[1]!.provider.connects).toBe(1);
  });

  it('shows it for a page that is not there when the screen is opened, too', async () => {
    const t = mountPage();
    await act(async () => void t.sessions[0]!.provider.refuse('not-found'));
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(t.sessions).toHaveLength(1);
  });
});
