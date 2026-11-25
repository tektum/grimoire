import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiLike } from '../../src/api/query';
import { createWebApi } from '../../src/api/client';
import { guardedFetch, markClientOutdated } from '../../src/gate/outdated';
import { notify, Toaster } from '../../src/ui/primitives';
import { SessionContext, type Session } from '../../src/auth/session';
import { POLL_MS } from '../../src/import/api';
import type { ImportState } from '../../src/import/types';
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
}
function fake(options: Options = {}) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let reads = 0;
  let creates = 0;
  let starts = 0;
  const answer = (status: number, body?: unknown, code?: string) => ({ data: status < 300 ? body : undefined, error: status < 300 ? undefined : { error: { code } }, response: new Response(null, { status }) });
  const api = {
    GET: async (path: string) => {
      calls.push(`GET ${path}`);
      if (path === '/v1/me') return answer(200, { id: 'u', name: 'Alice', email: 'a@x', role: options.role ?? 'member' });
      if (path === '/v1/collections') return answer(200, { items: COLLECTIONS });
      if (path === '/v1/imports/{id}') {
        const states = options.states ?? [state()];
        return answer(200, states[Math.min(reads++, states.length - 1)]);
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
    ['an import that has already started', { start: { status: 409, code: 'already_started' } }, 'That import has already started.'],
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
    const auth = { getToken: async () => 'token', refresh: async () => false, signOut: async () => undefined } as unknown as Session['auth'];
    const api = createWebApi({
      baseUrl: 'http://api.test',
      getToken: () => auth.getToken(),
      refresh: () => auth.refresh(),
      signOut: (r) => auth.signOut(r),
      notify,
      reload: markClientOutdated,
      fetch: guardedFetch,
    }) as unknown as ApiLike;
    const session = { auth, api, collabUrl: 'ws://x', apiUrl: 'http://api.test' } as unknown as Session;
    render(
      <SessionContext.Provider value={session}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={['/import']}>
            <Toaster />
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
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    }); // a notice, if one were sent, is drawn by now
    expect(document.body.textContent).not.toContain('Something went wrong');
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
