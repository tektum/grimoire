import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiLike } from '../../src/api/query';
import { createWebApi } from '../../src/api/client';
import { guardedFetch, markClientOutdated } from '../../src/gate/outdated';
import { SessionContext, type Session } from '../../src/auth/session';
import { POLL_MS, useImportReport } from '../../src/import/api';
import type { ImportItem, ImportState } from '../../src/import/types';
import ImportScreen from '../../src/screens/import';
import '../support/dom';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const COLLECTIONS = [
  { id: 'c1', name: 'Dev', myPermission: 'read-write' },
  { id: 'c2', name: 'Handbook', myPermission: 'read-only' },
  { id: 'c3', name: 'Notes', myPermission: 'read-write' },
];
const state = (over: Partial<ImportState> & { done?: number; total?: number } = {}): ImportState => ({
  status: 'running',
  counts: { pagesTotal: over.total ?? 10, pagesDone: over.done ?? 0, attachments: 0, skipped: 0, failed: 0, ...(over.counts ?? {}) },
  startedAt: '2026-11-20T10:00:00Z',
  finishedAt: null,
  error: null,
  ...(over.status === undefined ? {} : { status: over.status }),
  ...(over.error === undefined ? {} : { error: over.error }),
});

type Refusal = { status: number; code?: string };
const nth = (v: Refusal | Refusal[] | undefined, n: number, dflt: Refusal): Refusal => (v === undefined ? dflt : Array.isArray(v) ? (v[Math.min(n, v.length - 1)] ?? dflt) : v);

interface Options {
  role?: string;
  states?: ImportState[];
  /** One answer, or one after another (the last goes on for ever). */
  create?: Refusal | Refusal[];
  start?: Refusal | Refusal[];
  /** The report, a page after another (the cursor is the index of the page). */
  items?: ImportItem[][];
  itemsFail?: () => boolean;
  config?: Record<string, unknown> | undefined;
  source?: { status: number; url?: string };
  cancel?: { status: number; code?: string };
}
function fake(options: Options = {}) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let reads = 0;
  let creates = 0;
  let starts = 0;
  const answer = (status: number, body?: unknown, code?: string) => ({ data: status < 300 ? body : undefined, error: status < 300 ? undefined : { error: { code } }, response: new Response(null, { status }) });
  const api = {
    GET: async (path: string, init?: { params?: unknown }) => {
      calls.push(`GET ${path}`);
      if (path === '/v1/me') return answer(200, { id: 'u', name: 'Alice', email: 'a@x', role: options.role ?? 'member' });
      if (path === '/v1/collections') return answer(200, { items: COLLECTIONS });
      if (path === '/v1/imports/{id}') {
        const states = options.states ?? [state()];
        return answer(200, states[Math.min(reads++, states.length - 1)]);
      }
      if (path === '/v1/config') return answer(200, options.config ?? {});
      if (path === '/v1/imports/{id}/items') {
        if (options.itemsFail?.() === true) return answer(503);
        const pages = options.items ?? [[]];
        const at = Number((init?.params as { query?: { cursor?: string } } | undefined)?.query?.cursor ?? 0);
        return answer(200, { items: pages[at] ?? [], nextCursor: at + 1 < pages.length ? String(at + 1) : null });
      }
      if (path === '/v1/imports/{id}/items/{itemId}/source') {
        const r = options.source ?? { status: 200, url: 'https://files.test/source/a.md?sig=1' };
        return answer(r.status, { url: r.url, expiresAt: '2026-11-20T11:00:00Z' });
      }
      return answer(404);
    },
    POST: async (path: string, init?: { body?: unknown }) => {
      calls.push(`POST ${path}`);
      if (init?.body !== undefined) bodies.push(init.body);
      if (path === '/v1/imports') {
        const c = nth(options.create, creates++, { status: 201 });
        return answer(
          c.status,
          { id: 'imp1', upload: { method: 'PUT', url: 'https://files.test/imports/imp1.zip?sig=x', headers: { 'content-type': 'application/zip', 'if-none-match': '*' }, expiresAt: '2026-11-20T11:00:00Z' } },
          c.code,
        );
      }
      if (path === '/v1/imports/{id}/start') {
        const s = nth(options.start, starts++, { status: 202 });
        return answer(s.status, { status: 'running' }, s.code);
      }
      if (path === '/v1/imports/{id}/cancel') {
        const c = options.cancel ?? { status: 202 };
        return answer(c.status, { status: 'cancelled' }, c.code);
      }
      return answer(404);
    },
    PUT: async () => answer(500),
    PATCH: async () => answer(500),
    DELETE: async () => answer(500),
  } as unknown as ApiLike;
  return { api, calls, bodies };
}

const Where = () => {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
};
function show(api: ApiLike, at = '/import') {
  const session = { auth: {}, api, collabUrl: 'ws://x' } as unknown as Session; // no API address: the form uses this client as it is (a fake)
  return render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[at]}>
          <Routes>
            <Route
              path="/import"
              element={
                <>
                  <ImportScreen />
                  <Where />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
}
const zip = () => new File([new Uint8Array(1234)], 'export.zip', { type: 'application/zip' });
const choose = async () => {
  await userEvent.upload(await screen.findByLabelText('Choose a .zip file'), zip());
};

describe('the import screen', () => {
  it('is the not-found screen for a viewer, and asks nothing about imports', async () => {
    const t = fake({ role: 'viewer' });
    show(t.api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(t.calls.filter((c) => c.includes('imports'))).toEqual([]);
  });

  it('shows the duplicate-run warning before anything is chosen, and the writable collections only', async () => {
    show(fake().api);
    expect((await screen.findByRole('note')).textContent).toBe('Running this import again creates a second copy of every page.');
    await waitFor(() =>
      expect(
        within(screen.getByLabelText('Into the collection'))
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Dev', 'Notes']),
    );
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true); // no file yet
  });

  it('draws the file input as a labelled button, shows the name of the chosen file after it, and keeps it a real file input that the keyboard reaches', async () => {
    show(fake().api);
    const input = (await screen.findByLabelText('Choose a .zip file')) as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.getAttribute('accept')).toContain('.zip');
    expect(screen.getByText('No file chosen')).toBeTruthy();
    expect(input.getAttribute('aria-describedby')).toBe('import-file-name');
    await userEvent.tab(); // the collection select first, then the file input: both are in the Tab order
    await userEvent.tab();
    expect(document.activeElement).toBe(input);
    await userEvent.upload(input, zip());
    expect(document.getElementById('import-file-name')!.textContent).toBe('export.zip');
  });

  it('makes the import, PUTs the zip with the headers the API gave, starts it, and goes on to watch it', async () => {
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', put);
    const t = fake({ states: [state({ done: 0 })] });
    show(t.api);
    await choose();
    await userEvent.selectOptions(screen.getByLabelText('Into the collection'), 'c3');
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/import?import=imp1'));
    expect(t.bodies).toEqual([{ collectionId: 'c3', fileName: 'export.zip', size: 1234 }]);
    expect(put).toHaveBeenCalledTimes(1);
    const [url, init] = put.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://files.test/imports/imp1.zip?sig=x');
    expect(init).toMatchObject({ method: 'PUT', credentials: 'omit', headers: { 'content-type': 'application/zip', 'if-none-match': '*' } });
    expect(t.calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /v1/imports', 'POST /v1/imports/{id}/start']); // create, then (after the PUT) start
    expect(await screen.findByRole('progressbar')).toBeTruthy();
  });

  it('goes on with the import it made when the start was refused and the person tries again: one import, one PUT, a second start', async () => {
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', put);
    const t = fake({ start: [{ status: 500 }, { status: 202 }] });
    show(t.api);
    await choose();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The import could not be started. Try again.');
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/import?import=imp1'));
    expect(t.calls.filter((c) => c === 'POST /v1/imports')).toHaveLength(1); // no second import is made
    expect(put).toHaveBeenCalledTimes(1); // and the file that arrived is not sent again
    expect(t.calls.filter((c) => c === 'POST /v1/imports/{id}/start')).toHaveLength(2);
  });

  it('goes on to watch the import when the retry of a start that did reach the server says it has already started', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const t = fake({ start: [{ status: 503 }, { status: 409, code: 'already_started' }] });
    show(t.api);
    await choose();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/import?import=imp1'));
    expect(screen.queryByText('That import has already started.')).toBeNull();
  });

  it('sends the file again, to the same import, when the start says it did not arrive', async () => {
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', put);
    const t = fake({ start: [{ status: 409, code: 'upload_missing' }, { status: 202 }] });
    show(t.api);
    await choose();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The file did not arrive. Try again.');
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/import?import=imp1'));
    expect(put).toHaveBeenCalledTimes(2);
    expect(t.calls.filter((c) => c === 'POST /v1/imports')).toHaveLength(1);
  });

  it('after a refusal of the creation, the same file tried again makes the import and goes on; after an expired upload address it makes a new one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const t = fake({ create: [{ status: 429 }, { status: 201 }] });
    show(t.api);
    await choose();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Too many imports were started. Try again in a while.');
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/import?import=imp1'));
    cleanup();
    const refused = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', refused);
    const u = fake();
    show(u.api);
    await choose();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/import?import=imp1'));
    expect(u.calls.filter((c) => c === 'POST /v1/imports')).toHaveLength(2); // the address the 403 refused was not used again
  });

  it.each([
    ['too large for an import', { create: { status: 413 } }, 'That file is larger than an import may be.'],
    ['a collection that is gone', { create: { status: 404 } }, 'That collection can’t be found.'],
    ['not a zip', { start: { status: 422, code: 'not_a_zip' } }, 'That is not a zip file.'],
    ['a file that did not arrive', { start: { status: 409, code: 'upload_missing' } }, 'The file did not arrive. Try again.'],
    ['a collection that cannot be written', { create: { status: 403 } }, 'You can’t import into that collection.'],
    ['a file that cannot be imported', { create: { status: 422 } }, 'That file can’t be imported.'],
    ['too many imports started', { create: { status: 429 } }, 'Too many imports were started. Try again in a while.'],
    ['an answer that is none of those', { create: { status: 500 } }, 'The import could not be started. Try again.'],
    ['a refusal to start that is none of those', { start: { status: 500 } }, 'The import could not be started. Try again.'],
  ] as const)('says so, in an alert, for %s, and lets the person try again', async (_name, options, text) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    show(fake(options).api);
    await choose();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect((await screen.findByRole('alert')).textContent).toBe(text);
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('where').textContent).toBe('/import');
  });

  it('says the file could not be sent when the PUT is refused or does not reach the store, and never starts the import', async () => {
    for (const send of [
      vi.fn(async () => new Response(null, { status: 403 })),
      vi.fn(async () => {
        throw new TypeError('network');
      }),
    ]) {
      vi.stubGlobal('fetch', send);
      const t = fake();
      show(t.api);
      await choose();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));
      expect((await screen.findByRole('alert')).textContent).toBe('The file could not be sent. Try again.');
      expect(t.calls).not.toContain('POST /v1/imports/{id}/start');
      cleanup();
    }
  });
});

describe('the first read of an import fails', () => {
  it('offers to read it again, which shows the import that is running, before it offers to start again', async () => {
    const t = fake({ states: [state({ done: 4 })] });
    const inner = (t.api as unknown as { GET: (p: string) => Promise<unknown> }).GET;
    let broken = true;
    (t.api as unknown as { GET: (p: string) => Promise<unknown> }).GET = async (path: string) => (path === '/v1/imports/{id}' && broken ? { error: {}, response: new Response(null, { status: 503 }) } : inner(path));
    show(t.api, '/import?import=imp1');
    const alert = await screen.findByRole('alert');
    expect(
      within(alert)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Try again', 'Start again']);
    broken = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('an answer that is not shaped as the contract says', () => {
  it('is an import that cannot be started when the creation answers without the upload, and an import that cannot be read when the state has no counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const t = fake();
    const post = (t.api as unknown as { POST: (p: string, i?: unknown) => Promise<unknown> }).POST;
    (t.api as unknown as { POST: (p: string, i?: unknown) => Promise<unknown> }).POST = async (path: string, init?: unknown) =>
      path === '/v1/imports' ? { data: { id: 'imp1' }, response: new Response(null, { status: 201 }) } : post(path, init);
    show(t.api);
    await choose();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The import could not be started. Try again.');
    expect(t.calls).not.toContain('POST /v1/imports/{id}/start');
    cleanup();
    const u = fake({ states: [{ status: 'running' } as unknown as ImportState] });
    show(u.api, '/import?import=imp1');
    expect((await screen.findByRole('alert')).textContent).toContain('That import can’t be read.');
  });
});

const item = (over: Partial<ImportItem> & { id: string }): ImportItem => ({
  path: `docs/${over.id}.md`,
  kind: 'page',
  pageId: 'p1',
  status: 'imported',
  message: null,
  markdownBytes: 10,
  stateBytes: 20,
  hasSource: false,
  ...over,
});
const ended = (over: Partial<ImportState> & { done?: number; total?: number } = {}) => state({ status: 'done', done: 3, total: 3, ...over });

describe('the report of an ended import', () => {
  it('lists one row for each file with what happened to it, and the name of a file as text, never as markup', async () => {
    const t = fake({
      states: [ended()],
      items: [[item({ id: 'a' }), item({ id: 'b', status: 'skipped', message: 'too_large' }), item({ id: 'c', path: '<b>bold</b>.md', status: 'failed', message: '<img src=x onerror=alert(1)>' })]],
    });
    show(t.api, '/import?import=imp1');
    const list = await screen.findByRole('list', { name: 'Files of the import' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('data-status')),
    ).toEqual(['imported', 'skipped', 'failed']);
    expect(list.textContent).toContain('The page is larger than the limit for a page.');
    expect(list.textContent).not.toContain('too_large');
    expect(list.textContent).toContain('<b>bold</b>.md');
    expect(list.textContent).not.toContain('onerror'); // a message that is not a code is never shown
    expect(list.querySelector('b, img')).toBeNull();
  });

  it('asks nothing of the report while the import is running, and says when there is nothing to list', async () => {
    const t = fake({ states: [state()], items: [[]] });
    show(t.api, '/import?import=imp1');
    await screen.findByRole('progressbar');
    expect(t.calls.some((c) => c.includes('/items'))).toBe(false);
    cleanup();
    show(fake({ states: [ended()], items: [[]] }).api, '/import?import=imp1');
    expect(await screen.findByText('There is nothing to list.')).toBeTruthy();
  });

  it('reads the next page when asked, and says so when the report cannot be read, with a way to try again', async () => {
    let broken = false;
    const t = fake({ states: [ended()], items: [[item({ id: 'a' })], [item({ id: 'b' })]], itemsFail: () => broken });
    show(t.api, '/import?import=imp1');
    await screen.findByText('docs/a.md');
    broken = true;
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The report can’t be read right now.');
    expect(screen.getByText('docs/a.md')).toBeTruthy(); // what came stays
    broken = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('docs/b.md');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('the source of a failed page', () => {
    const clicks: string[] = [];
    const spy = () =>
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push(this.href);
      });
    const failed = [[item({ id: 'a' }), item({ id: 'f', status: 'failed', hasSource: true, message: 'broken' }), item({ id: 'g', status: 'failed', hasSource: false })]];

    it('offers it only for a failed page whose original is kept, and starts the download from the address the API gave', async () => {
      clicks.length = 0;
      const click = spy();
      show(fake({ states: [ended({ counts: { pagesTotal: 3, pagesDone: 1, attachments: 0, skipped: 0, failed: 2 } })], items: failed }).api, '/import?import=imp1');
      await screen.findByText('docs/f.md');
      expect(screen.getAllByRole('button', { name: /^Download source of/ })).toHaveLength(1);
      await userEvent.click(screen.getByRole('button', { name: 'Download source of docs/f.md' }));
      await waitFor(() => expect(clicks).toEqual(['https://files.test/source/a.md?sig=1']));
      click.mockRestore();
    });

    it.each([
      ['an address that is not safe', { status: 200, url: 'javascript:alert(1)' }],
      ['an answer that is a refusal', { status: 404 }],
    ])('says it cannot be downloaded for %s, and starts nothing', async (_n, source) => {
      clicks.length = 0;
      const click = spy();
      show(fake({ states: [ended()], items: failed, source }).api, '/import?import=imp1');
      await userEvent.click(await screen.findByRole('button', { name: 'Download source of docs/f.md' }));
      expect((await screen.findByRole('alert')).textContent).toContain('The source can’t be downloaded right now.');
      expect(clicks).toEqual([]);
      click.mockRestore();
    });
  });
});

describe('the report of one import, then of another', () => {
  it('shows the files of the import it was asked for, whichever answer comes last', async () => {
    const later: Record<string, () => void> = {};
    const answers: Record<string, ImportItem[]> = { a: [item({ id: 'a1' })], b: [item({ id: 'b1' })] };
    const api = {
      GET: (_path: string, init: { params: { path: { id: string } } }) =>
        new Promise((resolve) => {
          const id = init.params.path.id;
          later[id] = () => resolve({ data: { items: answers[id], nextCursor: null }, response: new Response(null, { status: 200 }) });
        }),
    } as unknown as ApiLike;
    const { result, rerender } = renderHook(({ id }) => useImportReport(api, id), { initialProps: { id: 'a' } });
    await waitFor(() => expect(later['a']).toBeDefined());
    rerender({ id: 'b' });
    await waitFor(() => expect(later['b']).toBeDefined());
    await act(async () => {
      later['b']!();
    });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['b1']));
    await act(async () => {
      later['a']!(); // the answer for the first import comes last
    });
    expect(result.current.items.map((i) => i.id)).toEqual(['b1']);
    expect(result.current.phase).toBe('ready');
  });

  it('shows nothing of the first import while the second one is read', async () => {
    const api = {
      GET: (_p: string, init: { params: { path: { id: string } } }) =>
        init.params.path.id === 'a' ? Promise.resolve({ data: { items: [item({ id: 'a1' })], nextCursor: null }, response: new Response(null, { status: 200 }) }) : new Promise(() => undefined),
    } as unknown as ApiLike;
    const { result, rerender } = renderHook(({ id }) => useImportReport(api, id), { initialProps: { id: 'a' } });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    rerender({ id: 'b' });
    await waitFor(() => expect(result.current.items).toEqual([]));
    expect(result.current.phase).toBe('loading');
  });
});

describe('a report that is not shaped as the contract says', () => {
  it.each([
    ['a source flag that is a string', 'false'],
    ['no source flag', undefined],
  ])('is a report that cannot be read for %s, so that no Download button is shown by mistake', async (_n, hasSource) => {
    const t = fake({ states: [ended()] });
    const inner = (t.api as unknown as { GET: (p: string, i?: unknown) => Promise<unknown> }).GET;
    (t.api as unknown as { GET: (p: string, i?: unknown) => Promise<unknown> }).GET = async (path: string, init?: unknown) =>
      path === '/v1/imports/{id}/items'
        ? { data: { items: [{ id: 'a', path: 'docs/a.md', status: 'failed', message: null, hasSource }], nextCursor: null }, response: new Response(null, { status: 200 }) }
        : inner(path, init);
    show(t.api, '/import?import=imp1');
    expect((await screen.findByRole('alert')).textContent).toContain('The report can’t be read right now.');
    expect(screen.queryByRole('button', { name: /^Download source of/ })).toBeNull();
  });

  it('is a report that cannot be read, not rows with holes in them', async () => {
    const t = fake({ states: [ended()] });
    const inner = (t.api as unknown as { GET: (p: string, i?: unknown) => Promise<unknown> }).GET;
    (t.api as unknown as { GET: (p: string, i?: unknown) => Promise<unknown> }).GET = async (path: string, init?: unknown) =>
      path === '/v1/imports/{id}/items' ? { data: { items: [{ id: 'a', path: 'docs/a.md', status: 'exploded', message: null }], nextCursor: null }, response: new Response(null, { status: 200 }) } : inner(path, init);
    show(t.api, '/import?import=imp1');
    expect((await screen.findByRole('alert')).textContent).toContain('The report can’t be read right now.');
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});

const SKIPPED = ['ignored', 'duplicate_path', 'too_large', 'entry_too_large', 'type_not_allowed', 'type_mismatch', 'unreferenced', 'nested_archive', 'empty'];
const FAILED = ['bad_name', 'invalid_encoding', 'size_mismatch', 'invalid-markdown', 'timeout', 'out-of-memory', 'state_too_large', 'content-lost', 'convert_failed', 'collection_full', 'internal'];

describe('what a person is told about a file: the reason is a code, and the screen has the words', () => {
  const reasons = (codes: string[], status: ImportItem['status'], config?: Record<string, unknown>) =>
    fake({ states: [ended()], config, items: [codes.map((message, n) => item({ id: `r${String(n)}`, status, message }))] });
  const messagesOf = async (list: HTMLElement, n: number) => {
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(n));
    return within(list)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.import-report-message')?.textContent?.trim() ?? '');
  };

  it.each([
    ['skipped', SKIPPED],
    ['failed', FAILED],
  ] as const)('puts every code of a %s file into a sentence of words that is not the code, and never shows a code', async (status, codes) => {
    show(reasons([...codes], status).api, '/import?import=imp1');
    const texts = await messagesOf(await screen.findByRole('list', { name: 'Files of the import' }), codes.length);
    expect(new Set(texts).size, 'one sentence for each code (the generic one is not used for a known code)').toBe(codes.length);
    for (const [n, text] of texts.entries()) {
      expect(text, codes[n]).toMatch(/^[A-Z].*\.$/);
      expect(text.toLowerCase(), codes[n]).not.toContain(codes[n]!.replace(/[_-]/g, ' ').includes(' ') ? codes[n]! : '\u0000');
      expect(text).not.toMatch(/[a-z]+[_-][a-z]+/);
    }
  });

  it('takes the limit a code names from the configuration of the server, and says no number when the server does not say one', async () => {
    show(reasons(['too_large', 'entry_too_large'], 'skipped', { maxMarkdownBytes: 131072, maxAttachmentBytes: 26214400 }).api, '/import?import=imp1');
    const texts = await messagesOf(await screen.findByRole('list', { name: 'Files of the import' }), 2);
    expect(texts[0]).toBe('The page is larger than the limit of 128 KB.');
    expect(texts[1]).toBe('The file is larger than the limit of 25 MB.');
    cleanup();
    show(reasons(['too_large', 'entry_too_large'], 'skipped', { maxMarkdownBytes: null, maxAttachmentBytes: null }).api, '/import?import=imp1');
    const none = await messagesOf(await screen.findByRole('list', { name: 'Files of the import' }), 2);
    expect(none[0]).toBe('The page is larger than the limit for a page.');
    expect(none[1]).toBe('The file is larger than the limit for a file.');
    expect(none.join(' ')).not.toMatch(/\d/);
  });

  it('says the generic sentence of the status for a code it does not know, for no reason and for text that is not a code, and never the text', async () => {
    show(
      fake({
        states: [ended()],
        items: [
          [
            item({ id: 'u1', status: 'skipped', message: 'some_new_code' }),
            item({ id: 'u2', status: 'failed', message: null }),
            item({ id: 'u3', status: 'failed', message: '/home/alice/notes/secret.md could not be read' }),
          ],
        ],
      }).api,
      '/import?import=imp1',
    );
    const list = await screen.findByRole('list', { name: 'Files of the import' });
    expect(await messagesOf(list, 3)).toEqual(['The file was left out.', 'The file could not be imported.', 'The file could not be imported.']);
    expect(list.textContent).not.toContain('secret.md could');
  });
});

describe('the progress bar of an ended import', () => {
  it('is full for an import that is done, with the skipped and the failed counted as handled', async () => {
    show(fake({ states: [ended({ done: 2, total: 4, counts: { pagesTotal: 4, pagesDone: 2, attachments: 0, skipped: 1, failed: 1 } })] }).api, '/import?import=imp1');
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100'));
  });

  it('counts the skipped and the failed as handled while it runs, and shows how far a cancelled import got', async () => {
    show(fake({ states: [state({ done: 2, total: 10, counts: { pagesTotal: 10, pagesDone: 2, attachments: 0, skipped: 1, failed: 1 } })] }).api, '/import?import=imp1');
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40'));
    cleanup();
    show(fake({ states: [state({ status: 'cancelled', done: 3, total: 10 })] }).api, '/import?import=imp1');
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30'));
  });
});

describe('a cancel that was refused', () => {
  it('is not said once the import has ended, which the read after the refusal shows', async () => {
    const t = fake({ states: [state(), ended()], cancel: { status: 500 } });
    show(t.api, '/import?import=imp1');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel import' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Done'));
    expect(screen.queryByText('The import could not be cancelled. Try again.')).toBeNull();
  });
});

describe('cancelling an import', () => {
  it('offers it while running only, and says what became of the import once it is cancelled, which then offers the report', async () => {
    const t = fake({ states: [state({ done: 4 }), state({ status: 'cancelled', done: 4 })], items: [[item({ id: 'a' })]] });
    show(t.api, '/import?import=imp1');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel import' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Cancelled. The pages it created were moved to the trash.'));
    expect(t.calls).toContain('POST /v1/imports/{id}/cancel');
    expect(screen.queryByRole('button', { name: 'Cancel import' })).toBeNull();
    expect(await screen.findByText('docs/a.md')).toBeTruthy();
  });

  it('is not offered for an import that has not started or has ended', async () => {
    show(fake({ states: [ended()] }).api, '/import?import=imp1');
    await screen.findByRole('status');
    expect(screen.queryByRole('button', { name: 'Cancel import' })).toBeNull();
  });

  it('takes a 409 for an import that ended in the meantime: no alert, the state read says how', async () => {
    const t = fake({ states: [state(), ended()], cancel: { status: 409, code: 'not_running' } });
    show(t.api, '/import?import=imp1');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel import' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Done'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when the cancel is refused for any other reason, and leaves the import running', async () => {
    show(fake({ states: [state()], cancel: { status: 500 } }).api, '/import?import=imp1');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel import' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The import could not be cancelled. Try again.');
    expect(screen.getByRole('button', { name: 'Cancel import' })).toBeTruthy();
  });
});

describe('one message for a refusal', () => {
  it("shows the screen's own words for a refused start and no generic notice beside them (the real client, whose notices the form turns off)", async () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const request = typeof input === 'string' ? new Request(input, init) : input;
        const { pathname } = new URL(request.url);
        if (request.method === 'PUT') return new Response(null, { status: 200 });
        if (pathname === '/v1/me') return json(200, { id: 'u', name: 'Alice', email: 'a@x', role: 'member' });
        if (pathname === '/v1/collections') return json(200, { items: COLLECTIONS });
        if (pathname === '/v1/imports') return json(201, { id: 'imp1', upload: { method: 'PUT', url: 'https://files.test/z', headers: {}, expiresAt: 'x' } });
        if (pathname.endsWith('/start')) return json(422, { error: { code: 'not_a_zip', message: 'No' } });
        return json(404, {});
      }),
    );
    const notices = vi.fn();
    const auth = { getToken: async () => 'token', refresh: async () => false, signOut: async () => undefined } as unknown as Session['auth'];
    const api = createWebApi({
      baseUrl: 'http://api.test',
      getToken: () => auth.getToken(),
      refresh: () => auth.refresh(),
      signOut: (r) => auth.signOut(r),
      notify: notices, // the session's own client tells the person through this; the form's client must not
      reload: markClientOutdated,
      fetch: guardedFetch,
    }) as unknown as ApiLike;
    const session = { auth, api, collabUrl: 'ws://x', apiUrl: 'http://api.test' } as unknown as Session;
    render(
      <SessionContext.Provider value={session}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={['/import']}>
            <Routes>
              <Route path="/import" element={<ImportScreen />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </SessionContext.Provider>,
    );
    await choose();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That is not a zip file.');
    expect(notices).not.toHaveBeenCalled(); // no generic notice: the request has been answered by now, and the client tells its notice before it returns the answer
  });
});

describe('when reading fails', () => {
  const failingPolls = (okStates: ImportState[], failAfter: number) => {
    const t = fake({ states: okStates });
    const inner = (t.api as unknown as { GET: (p: string) => Promise<unknown> }).GET;
    let reads = 0;
    let broken = true;
    (t.api as unknown as { GET: (p: string) => Promise<unknown> }).GET = async (path: string) => {
      if (path === '/v1/imports/{id}' && reads++ >= failAfter && broken) return { error: {}, response: new Response(null, { status: 503 }) };
      return inner(path);
    };
    return {
      t,
      mend: () => {
        broken = false;
      },
      reads: () => reads,
    };
  };

  it('stops asking about an import that cannot be read, instead of asking every two seconds for as long as the page is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = failingPolls([state()], 0);
    show(f.t.api, '/import?import=gone');
    await screen.findByRole('alert');
    const after = f.reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    });
    expect(f.reads()).toBe(after);
  });

  it('shows the failure of a later poll beside the last progress, with a way to try again, and goes on when it works', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = failingPolls([state({ done: 4 }), state({ done: 8 })], 1);
    show(f.t.api, '/import?import=imp1');
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The progress can’t be read right now.');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40'); // the last known progress stays
    f.mend();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('80'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the collections could not be loaded, with a way to try again, instead of a form that is dead without a word', async () => {
    const t = fake();
    const inner = (t.api as unknown as { GET: (p: string) => Promise<unknown> }).GET;
    let broken = true;
    (t.api as unknown as { GET: (p: string) => Promise<unknown> }).GET = async (path: string) => (path === '/v1/collections' && broken ? { error: {}, response: new Response(null, { status: 503 }) } : inner(path));
    show(t.api);
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load your collections.');
    broken = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(
        within(screen.getByLabelText('Into the collection'))
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Dev', 'Notes']),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the screen around it', () => {
  it('says it could not tell who the person is, and asks again on request', async () => {
    const t = fake();
    let fail = true;
    const get = (t.api as unknown as { GET: (p: string) => Promise<unknown> }).GET;
    (t.api as unknown as { GET: (p: string) => Promise<unknown> }).GET = async (path: string) => (path === '/v1/me' && fail ? { error: {}, response: new Response(null, { status: 503 }) } : get(path));
    show(t.api);
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't check who you are.");
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('note')).toBeTruthy();
  });

  it('offers nothing to import into when there is no collection to write in, and says nothing is started', async () => {
    const t = fake();
    const get = (t.api as unknown as { GET: (p: string) => Promise<unknown> }).GET;
    (t.api as unknown as { GET: (p: string) => Promise<unknown> }).GET = async (path: string) =>
      path === '/v1/collections' ? { data: { items: [COLLECTIONS[1]] }, response: new Response(null, { status: 200 }) } : get(path);
    show(t.api);
    await screen.findByRole('note');
    await choose();
    expect((screen.getByLabelText('Into the collection') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says an import that has not begun is waiting, and an ended one offers to import another file, which goes back to the form', async () => {
    show(fake({ states: [state({ status: 'uploaded' })] }).api, '/import?import=imp1');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Waiting to start…'));
    expect(screen.queryByRole('button', { name: 'Import another file' })).toBeNull();
    cleanup();
    show(fake({ states: [state({ status: 'cancelled' })] }).api, '/import?import=imp1');
    await userEvent.click(await screen.findByRole('button', { name: 'Import another file' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/import'));
    expect(await screen.findByRole('note')).toBeTruthy();
  });

  it('says the import could not be started in the generic words when what failed is not an answer of the API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const t = fake();
    (t.api as unknown as { POST: () => Promise<unknown> }).POST = async () => {
      throw new Error('boom');
    };
    show(t.api);
    await choose();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The import could not be started. Try again.');
  });
});

describe('the progress of an import', () => {
  it.each([
    [0, 0, 'Importing: 0 of 10 pages'],
    [4, 40, 'Importing: 4 of 10 pages'],
    [10, 100, 'Importing: 10 of 10 pages'],
  ])('shows %i of 10 pages as a progress bar with the value %i percent', async (done, value, text) => {
    show(fake({ states: [state({ done })] }).api, '/import?import=imp1');
    const bar = await screen.findByRole('progressbar', { name: 'Import progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe(String(value));
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(screen.getByRole('status').textContent).toBe(text);
  });

  it('is 0 percent while the number of pages is not known, never NaN', async () => {
    show(fake({ states: [state({ total: 0, done: 0 })] }).api, '/import?import=imp1');
    expect((await screen.findByRole('progressbar')).getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByRole('status').textContent).toBe('Importing…');
  });

  it('says in words how it ended: done with what was skipped and failed, failed with its code, cancelled (the pages are in the trash)', async () => {
    show(fake({ states: [state({ status: 'done', done: 8, total: 10, counts: { skipped: 1, failed: 1 } as ImportState['counts'] })] }).api, '/import?import=imp1');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Done: 8 pages imported, 1 skipped, 1 failed.'));
    cleanup();
    show(fake({ states: [state({ status: 'failed', error: 'internal' })] }).api, '/import?import=imp1');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('The import failed (internal). The pages it created were moved to the trash.'));
    cleanup();
    show(fake({ states: [state({ status: 'cancelled' })] }).api, '/import?import=imp1');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Cancelled. The pages it created were moved to the trash.'));
  });

  it('is read again every two seconds while it runs, and not any more once it has ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t = fake({ states: [state({ done: 2 }), state({ done: 6 }), state({ status: 'done', done: 10 })] });
    show(t.api, '/import?import=imp1');
    const reads = () => t.calls.filter((c) => c === 'GET /v1/imports/{id}').length;
    await screen.findByRole('progressbar');
    expect(reads()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    });
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('60'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Done'));
    const after = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    });
    expect(reads()).toBe(after);
  });

  it('says an import that cannot be read cannot be, and offers to start again', async () => {
    const t = fake();
    (t.api as unknown as { GET: (p: string) => Promise<unknown> }).GET = async (path: string) =>
      path === '/v1/imports/{id}' ? { error: {}, response: new Response(null, { status: 404 }) } : { data: path === '/v1/me' ? { role: 'member' } : { items: COLLECTIONS }, response: new Response(null, { status: 200 }) };
    show(t.api, '/import?import=gone');
    expect((await screen.findByRole('alert')).textContent).toContain('That import can’t be read.');
  });
});
