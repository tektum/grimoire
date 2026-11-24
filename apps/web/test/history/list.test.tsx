import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RevisionList } from '../../src/screens/history/RevisionList';
import '../support/dom';
import { fakeApi, ok, PAGE, renderAt, rev } from './support';

const LIST = 'GET /v1/pages/{id}/revisions';
const show = (api: ReturnType<typeof fakeApi>['api']) => renderAt(<RevisionList api={api} page={PAGE} slug="quarterly-plan-abc123" />, '/p/quarterly-plan-abc123/history');

describe('the revision list', () => {
  it('lists the versions newest first as the API gives them, each with its time, why it was kept and who edited', async () => {
    const { api, of } = fakeApi({
      [LIST]: ok({
        items: [rev('r2', { reason: 'last_editor_left', createdAt: Date.UTC(2026, 10, 21, 9, 5) }), rev('r1', { reason: 'before_restore', lastAuthor: null, authors: [] })],
        nextCursor: null,
      }),
    });
    show(api);
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('The last editor left')).toBeTruthy();
    expect(within(rows[0]!).getByText(/Alice Example/)).toBeTruthy();
    expect(within(rows[0]!).getByText(/Bob Builder/)).toBeTruthy();
    expect(within(rows[0]!).getByRole('time').getAttribute('datetime')).toBe(new Date(Date.UTC(2026, 10, 21, 9, 5)).toISOString());
    expect(within(rows[1]!).getByText('Kept before a restore')).toBeTruthy();
    expect(within(rows[1]!).getByText('No author recorded')).toBeTruthy();
    expect(of('GET', '/v1/pages/{id}/revisions')[0]?.params.path).toEqual({ id: 'p1' });
  });

  it('links each version to its own address under the page', async () => {
    const { api } = fakeApi({ [LIST]: ok({ items: [rev('r2'), rev('r1')], nextCursor: null }) });
    show(api);
    const links = await screen.findAllByRole('link', { name: /Open this version/ });
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/p/quarterly-plan-abc123/history/r2', '/p/quarterly-plan-abc123/history/r1']);
  });

  it('names the reasons in words for all five kinds', async () => {
    const reasons = ['idle', 'last_editor_left', 'before_restore', 'manual', 'import'];
    const { api } = fakeApi({ [LIST]: ok({ items: reasons.map((r, i) => rev(`r${String(i)}`, { reason: r })), nextCursor: null }) });
    show(api);
    await screen.findAllByRole('listitem');
    expect(screen.getAllByTestId('reason').map((e) => e.textContent)).toEqual(['Saved after editing stopped', 'The last editor left', 'Kept before a restore', 'Saved by a person', 'Imported']);
  });

  it('pages with Show more, using the cursor, and ends when there is no more', async () => {
    const { api, of } = fakeApi({
      [LIST]: (r) => ((r.params.query as { cursor?: string } | undefined)?.cursor === undefined ? ok({ items: [rev('r2')], nextCursor: 'c2' }) : ok({ items: [rev('r1')], nextCursor: null })),
    });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() => { expect(screen.getAllByRole('listitem')).toHaveLength(2); });
    expect(of('GET', '/v1/pages/{id}/revisions')[1]?.params.query).toMatchObject({ cursor: 'c2' });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('says so when the next page cannot be loaded, keeps what is shown, and Show more tries again', async () => {
    let later = 0;
    const { api, of } = fakeApi({
      [LIST]: (r) => ((r.params.query as { cursor?: string } | undefined)?.cursor === undefined ? ok({ items: [rev('r2')], nextCursor: 'c2' }) : later++ === 0 ? { status: 503 } : ok({ items: [rev('r1')], nextCursor: null })),
    });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load more versions");
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => { expect(screen.getAllByRole('listitem')).toHaveLength(2); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(of('GET', '/v1/pages/{id}/revisions')).toHaveLength(3);
  });

  it('says so when the page has no saved version yet', async () => {
    const { api } = fakeApi({ [LIST]: ok({ items: [], nextCursor: null }) });
    show(api);
    expect(await screen.findByText('No saved versions yet')).toBeTruthy();
  });

  it('shows the not-found screen when the list answers 404 (no access looks like no page)', async () => {
    const { api } = fakeApi({ [LIST]: { status: 404 } });
    show(api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
  });

  it('offers to try again when the list cannot be read', async () => {
    let attempt = 0;
    const { api } = fakeApi({ [LIST]: () => (attempt++ === 0 ? { status: 503 } : ok({ items: [rev('r1')], nextCursor: null })) });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('listitem')).toBeTruthy();
  });

  it('has a way back to the page', async () => {
    const { api } = fakeApi({ [LIST]: ok({ items: [], nextCursor: null }) });
    show(api);
    expect((await screen.findByRole('link', { name: 'Back to Quarterly plan' })).getAttribute('href')).toBe('/p/quarterly-plan-abc123');
  });
});
