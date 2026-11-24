import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ApiLike } from '../../src/api/query';
import { TrashScreen } from '../../src/screens/trash/TrashScreen';
import '../support/dom';
import { COLLECTIONS, fakeApi } from '../tree/support';

const item = (id: string, title: string, collectionId = 'c1', daysLeft = 20, deletedAt = Date.UTC(2026, 10, 20, 9, 0)) => ({ id, title, collectionId, daysLeft, deletedAt, deletedBy: null });
const ok = (body: unknown) => ({ status: 200, body });
const show = (api: ApiLike) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TrashScreen api={api} /></QueryClientProvider>);
const rows = () => screen.getAllByRole('listitem');

describe('the trash screen', () => {
  it('lists one row per deleted batch: the page, its collection, when it was deleted and how long it can still be restored', async () => {
    const { api } = fakeApi({
      'GET /v1/collections': ok({ items: COLLECTIONS }),
      'GET /v1/trash': ok({ items: [item('a', 'Plan for May', 'c1', 20), item('b', 'Old notes', 'c2', 1)], nextCursor: null }),
    });
    show(api);
    await screen.findByText('Plan for May');
    const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(Date.UTC(2026, 10, 20, 9, 0));
    expect(rows().map((r) => r.textContent)).toEqual([
      `Plan for MayDev · deleted ${date} · 20 days leftRestore`,
      `Old notesPrivate · deleted ${date} · 1 day leftRestore`,
    ]);
  });

  it('names an untitled page "Untitled", and a collection it cannot name by nothing', async () => {
    const { api } = fakeApi({ 'GET /v1/collections': ok({ items: [] }), 'GET /v1/trash': ok({ items: [item('a', '', 'gone')], nextCursor: null }) });
    show(api);
    expect(await screen.findByText('Untitled')).toBeTruthy();
    expect(rows()[0]?.textContent).not.toContain('undefined');
  });

  it('says the trash is empty when nothing is in it', async () => {
    const { api } = fakeApi({ 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/trash': ok({ items: [], nextCursor: null }) });
    show(api);
    expect(await screen.findByText('The trash is empty')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('restores a batch, says so, and reads the list again so it is gone from the trash', async () => {
    let restored = false;
    const { api, calls } = fakeApi({
      'GET /v1/collections': ok({ items: COLLECTIONS }),
      'GET /v1/trash': () => ok({ items: restored ? [] : [item('a', 'Plan for May')], nextCursor: null }),
      'POST /v1/trash/{id}/restore': () => { restored = true; return { status: 200, body: { id: 'a', title: 'Plan for May' } }; },
    });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Restore Plan for May' }));
    expect(await screen.findByText('The trash is empty')).toBeTruthy();
    expect(calls).toContain('POST /v1/trash/{id}/restore a');
    expect(calls.filter((c) => c.startsWith('GET /v1/trash'))).toHaveLength(2);
  });

  it('leaves the row and reads the list again when the restore is refused (the wrapper has said why), and offers it once more', async () => {
    const { api, calls } = fakeApi({
      'GET /v1/collections': ok({ items: COLLECTIONS }),
      'GET /v1/trash': ok({ items: [item('a', 'Plan for May')], nextCursor: null }),
      'POST /v1/trash/{id}/restore': { status: 409, body: { error: { code: 'collection_deleted', message: 'x' } } },
    });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Restore Plan for May' }));
    await waitFor(() => { expect(calls.filter((c) => c.startsWith('GET /v1/trash'))).toHaveLength(2); });
    expect(within(rows()[0] as HTMLElement).getByRole('button', { name: 'Restore Plan for May' }).hasAttribute('disabled')).toBe(false);
  });

  it('does not offer a second restore of a row while its restore is under way', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { api, calls } = fakeApi({
      'GET /v1/collections': ok({ items: COLLECTIONS }),
      'GET /v1/trash': ok({ items: [item('a', 'Plan for May')], nextCursor: null }),
      'POST /v1/trash/{id}/restore': () => { void gate; return { status: 200, body: {} }; },
    });
    const post = api.POST as unknown as (path: string, init: unknown) => Promise<unknown>;
    (api as unknown as { POST: typeof post }).POST = async (path, init) => { await gate; return post(path, init); };
    show(api);
    const button = await screen.findByRole('button', { name: 'Restore Plan for May' });
    await userEvent.click(button);
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.click(button);
    release();
    await waitFor(() => { expect(calls.filter((c) => c.startsWith('POST /v1/trash'))).toHaveLength(1); });
  });

  it('reads the next page of a long trash on request, and the last page has no such button', async () => {
    const { api, calls } = fakeApi({
      'GET /v1/collections': ok({ items: COLLECTIONS }),
      'GET /v1/trash': ok({ items: [item('a', 'First')], nextCursor: null }),
    });
    const first = { items: [item('a', 'First')], nextCursor: 'next-1' };
    const second = { items: [item('b', 'Second')], nextCursor: null };
    (api as unknown as { GET: (p: string, init?: { params?: { query?: { cursor?: string } } }) => Promise<unknown> }).GET = async (path, init) => {
      calls.push(`GET ${path}${init?.params?.query?.cursor === undefined ? '' : ` ?cursor=${init.params.query.cursor}`}`);
      const body = path === '/v1/collections' ? { items: COLLECTIONS } : init?.params?.query?.cursor === 'next-1' ? second : first;
      return { data: body, response: new Response(null, { status: 200 }) };
    };
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Second')).toBeTruthy();
    expect(calls).toContain('GET /v1/trash ?cursor=next-1');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('offers to try again when the trash cannot be read', async () => {
    let attempt = 0;
    const { api } = fakeApi({
      'GET /v1/collections': ok({ items: COLLECTIONS }),
      'GET /v1/trash': () => (attempt++ === 0 ? { status: 503 } : ok({ items: [item('a', 'Plan for May')], nextCursor: null })),
    });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Plan for May')).toBeTruthy();
  });

  it('says 0 days left on the last day', async () => {
    const { api } = fakeApi({ 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/trash': ok({ items: [item('a', 'Last day', 'c1', 0)], nextCursor: null }) });
    show(api);
    await screen.findByText('Last day');
    expect(rows()[0]?.textContent).toContain('0 days left');
  });

  it('keeps the row disabled while the list is being read again after a restore', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    const { api, calls } = fakeApi({
      'GET /v1/collections': ok({ items: COLLECTIONS }),
      'POST /v1/trash/{id}/restore': { status: 200, body: { id: 'a', title: 'Plan for May' } },
    });
    const get = api.GET as unknown as (path: string, init?: unknown) => Promise<unknown>;
    (api as unknown as { GET: typeof get }).GET = async (path, init) => {
      if (path === '/v1/trash') {
        reads += 1;
        if (reads > 1) await gate; // the read that follows the restore stays open
        return { data: { items: [item('a', 'Plan for May')], nextCursor: null }, response: new Response(null, { status: 200 }) };
      }
      return get(path, init);
    };
    show(api);
    const button = await screen.findByRole('button', { name: 'Restore Plan for May' });
    await userEvent.click(button);
    await waitFor(() => { expect(reads).toBe(2); });
    expect(calls.filter((c) => c.startsWith('POST /v1/trash'))).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Restore Plan for May' })?.hasAttribute('disabled') ?? true).toBe(true); // gone, or at least not clickable
    release();
  });

  it('takes a restored row off the list at once, so it cannot be restored again when the new read of the list fails', async () => {
    let reads = 0;
    const { api, calls } = fakeApi({
      'GET /v1/collections': ok({ items: COLLECTIONS }),
      'GET /v1/trash': () => (reads++ === 0 ? ok({ items: [item('a', 'Plan for May'), item('b', 'Old notes')], nextCursor: null }) : { status: 503 }),
      'POST /v1/trash/{id}/restore': { status: 200, body: { id: 'a', title: 'Plan for May' } },
    });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Restore Plan for May' }));
    await waitFor(() => { expect(reads).toBe(2); });
    expect(screen.queryByRole('button', { name: 'Restore Plan for May' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore Old notes' })).toBeTruthy();
    expect(calls.filter((c) => c.startsWith('POST /v1/trash'))).toHaveLength(1);
  });
});
