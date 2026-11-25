import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiLike } from '../../src/api/query';
import { NewCollection } from '../../src/screens/collections/NewCollection';
import '../support/dom';

afterEach(cleanup);

type Reply = { status?: number; id?: string; error?: unknown; throws?: boolean };
function fake(role: 'admin' | 'member' | 'viewer' | 'fails', reply: Reply = {}) {
  const posts: unknown[] = [];
  const api = {
    GET: async (path: string) => {
      if (path !== '/v1/me') return { data: { items: [] }, response: new Response(null, { status: 200 }) };
      return role === 'fails' ? { data: undefined, response: new Response(null, { status: 500 }) } : { data: { name: 'Ada', email: 'a@example.test', role }, response: new Response(null, { status: 200 }) };
    },
    POST: async (_path: string, init: { body: unknown }) => {
      posts.push(init.body);
      if (reply.throws === true) throw new TypeError('network');
      const status = reply.status ?? 201;
      return { data: status < 300 ? { id: reply.id ?? 'c-new', name: 'x' } : undefined, error: reply.error, response: new Response(null, { status }) };
    },
  } as unknown as ApiLike;
  return { api, posts };
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
function show(api: ApiLike, strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const view = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/collections/new']}>
        <Routes>
          <Route path="/collections/new" element={<NewCollection api={api} />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(strict ? <StrictMode>{view}</StrictMode> : view);
  return { invalidate };
}

describe('the new collection screen', () => {
  it('is for administrators: anyone else gets the not-found screen, and a failed check offers to try again', async () => {
    show(fake('member').api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    cleanup();
    show(fake('fails').api);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('asks for a name before it asks the server anything', async () => {
    const f = fake('admin');
    show(f.api);
    await userEvent.click(await screen.findByRole('button', { name: 'Create collection' }));
    expect(screen.getByRole('alert').textContent).toBe('Give the collection a name.');
    await userEvent.type(screen.getByLabelText('Name'), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Create collection' }));
    expect(screen.getByRole('alert').textContent).toBe('Give the collection a name.');
    expect(f.posts).toEqual([]);
  });

  it('creates it with what everyone may do, as chosen, trims the name, and goes to the new collection', async () => {
    const f = fake('admin', { id: 'c-42' });
    const { invalidate } = show(f.api);
    await userEvent.type(await screen.findByLabelText('Name'), '  Handbook ');
    await userEvent.click(screen.getByRole('button', { name: 'Create collection' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/c/c-42'));
    expect(f.posts).toEqual([{ name: 'Handbook', defaultPermission: 'read_write' }]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['GET', '/v1/collections', null] });
  });

  it.each([
    ['Everyone in the workspace can read', { name: 'Notes', defaultPermission: 'read' }],
    ['Only people you give access to', { name: 'Notes' }],
  ])('sends %s as the access of the collection', async (label, body) => {
    const f = fake('admin');
    show(f.api);
    await userEvent.type(await screen.findByLabelText('Name'), 'Notes');
    await userEvent.click(screen.getByLabelText(label));
    await userEvent.click(screen.getByRole('button', { name: 'Create collection' }));
    await waitFor(() => expect(f.posts).toEqual([body]));
  });

  it.each([
    [{ status: 422, error: { error: { code: 'invalid' } } }, 'That name can’t be used. Use 1 to 100 characters.'],
    [{ status: 409, error: { error: { code: 'name_taken' } } }, 'The collection could not be created. Try again.'], // the API has no such refusal: whatever it says that is not worded above is the general sentence
    [{ status: 403, error: { error: { code: 'forbidden' } } }, 'Only administrators can create collections.'],
    [{ status: 429 }, 'Too many requests. Try again in a moment.'],
    [{ status: 503 }, 'The collection could not be created. Try again.'],
    [{ throws: true }, 'The collection could not be created. Try again.'],
  ] as [Reply, string][])('says in plain words what went wrong (%j) and lets the person try again', async (reply, words) => {
    const f = fake('admin', reply);
    show(f.api);
    await userEvent.type(await screen.findByLabelText('Name'), 'Notes');
    await userEvent.click(screen.getByRole('button', { name: 'Create collection' }));
    expect((await screen.findByRole('alert')).textContent).toBe(words);
    expect((screen.getByRole('button', { name: 'Create collection' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Notes');
  });

  it('opens the new collection under StrictMode too, which mounts the form, unmounts it and mounts it again in development', async () => {
    const f = fake('admin', { id: 'c-strict' });
    show(f.api, true);
    await userEvent.type(await screen.findByLabelText('Name'), 'Notes');
    await userEvent.click(screen.getByRole('button', { name: 'Create collection' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/c/c-strict'));
  });

  it('does not open the new collection when the person has left the form before the answer comes', async () => {
    const f = fake('admin');
    let release: () => void = () => undefined;
    (f.api as unknown as { POST: unknown }).POST = (_p: string, init: { body: unknown }) => {
      f.posts.push(init.body);
      return new Promise((resolve) => (release = () => resolve({ data: { id: 'c-late' }, response: new Response(null, { status: 201 }) })));
    };
    show(f.api);
    await userEvent.type(await screen.findByLabelText('Name'), 'Notes');
    await userEvent.click(screen.getByRole('button', { name: 'Create collection' }));
    await waitFor(() => expect(f.posts).toHaveLength(1));
    await userEvent.click(screen.getByRole('link', { name: 'Cancel' }));
    expect(screen.getByTestId('where').textContent).toBe('/');
    release();
    await waitFor(() => expect(f.posts).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0)); // the continuation of the sent form runs on promises
    expect(screen.getByTestId('where').textContent).toBe('/');
  });

  it('cannot be sent twice while it is being sent', async () => {
    const f = fake('admin');
    let release: () => void = () => undefined;
    (f.api as unknown as { POST: unknown }).POST = (_p: string, init: { body: unknown }) => {
      f.posts.push(init.body);
      return new Promise((resolve) => (release = () => resolve({ data: { id: 'c1' }, response: new Response(null, { status: 201 }) })));
    };
    show(f.api);
    await userEvent.type(await screen.findByLabelText('Name'), 'Notes');
    const button = screen.getByRole('button', { name: 'Create collection' }) as HTMLButtonElement;
    await userEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    await userEvent.click(button);
    expect(f.posts).toHaveLength(1);
    release();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/c/c1'));
  });
});
