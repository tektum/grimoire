import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { MountedEditor } from '../../src/editor/core/mount';
import { RevisionView } from '../../src/screens/history/RevisionView';
import '../support/dom';
import { fakeApi, ok, PAGE, renderAt, rev } from './support';

const ONE = 'GET /v1/pages/{id}/revisions/{rid}';
const RESTORE = 'POST /v1/pages/{id}/revisions/{rid}/restore';
const mount = async (element: HTMLElement, markdown: string): Promise<MountedEditor> => {
  element.textContent = markdown;
  return { setEditable: () => undefined, markdown: () => markdown, applyMarkdown: () => undefined, destroy: async () => undefined };
};
const READ = { [ONE]: ok({ ...rev('r1'), markdown: '# Plan\n\nThe older text\n' }), 'GET /v1/pages/{id}/markdown': ok('# Plan\n\nThe newer text\n') };
const stale = { status: 409, body: { error: { code: 'markdown_stale', message: 'x' } } };

function Where() {
  const location = useLocation();
  return <output aria-label="location" data-state={JSON.stringify(location.state)}>{location.pathname}</output>;
}
const show = (api: ReturnType<typeof fakeApi>['api'], page = PAGE) =>
  renderAt(
    <>
      <Routes>
        <Route path="/p/:slug/history/:rid" element={<RevisionView api={api} page={page} slug="quarterly-plan-abc123" revisionId="r1" mount={mount} />} />
        <Route path="*" element={null} />
      </Routes>
      <Where />
    </>,
    '/p/quarterly-plan-abc123/history/r1',
  );
const ask = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Restore this version' }));
  return screen.findByRole('alertdialog', { name: 'Restore this version?' });
};

describe('restoring a version', () => {
  it('asks first, naming the time of the version, and sends nothing until it is confirmed', async () => {
    const { api, of } = fakeApi({ ...READ });
    show(api);
    const dialog = await ask();
    expect(within(dialog).getByText(/kept as a version first/)).toBeTruthy();
    expect(of('POST', '/v1/pages/{id}/revisions/{rid}/restore')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(screen.queryByRole('alertdialog')).toBeNull(); });
    expect(of('POST', '/v1/pages/{id}/revisions/{rid}/restore')).toHaveLength(0);
  });

  it('calls restore once and goes to the page with the returned Markdown, which the page applies as ordinary edits', async () => {
    const { api, of } = fakeApi({ ...READ, [RESTORE]: ok({ title: 'Quarterly plan', markdown: '# Plan\n\nThe older text\n', safetyRevisionId: 's1' }) });
    show(api);
    await userEvent.click(within(await ask()).getByRole('button', { name: 'Restore' }));
    await waitFor(() => { expect(screen.getByLabelText('location').textContent).toBe('/p/quarterly-plan-abc123'); });
    expect(JSON.parse(screen.getByLabelText('location').getAttribute('data-state') ?? 'null')).toEqual({ restoreMarkdown: '# Plan\n\nThe older text\n' });
    expect(of('POST', '/v1/pages/{id}/revisions/{rid}/restore')).toHaveLength(1);
    expect(of('POST', '/v1/pages/{id}/revisions/{rid}/restore')[0]?.params.path).toEqual({ id: 'p1', rid: 'r1' });
  });

  it('on markdown_stale says the page is still being saved, stays on the version and does not navigate', async () => {
    const { api, of } = fakeApi({ ...READ, [RESTORE]: stale });
    show(api);
    await userEvent.click(within(await ask()).getByRole('button', { name: 'Restore' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The page is still being saved. Try again in a moment.');
    expect(screen.getByLabelText('location').textContent).toBe('/p/quarterly-plan-abc123/history/r1');
    expect(screen.getByRole('heading', { level: 1, name: 'Quarterly plan' })).toBeTruthy();
    expect(of('POST', '/v1/pages/{id}/revisions/{rid}/restore')).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Restore this version' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('after the stale answer a second try restores and goes to the page, and the message is gone', async () => {
    let attempt = 0;
    const { api, of } = fakeApi({ ...READ, [RESTORE]: () => (attempt++ === 0 ? stale : ok({ title: 'Quarterly plan', markdown: '# Plan\n', safetyRevisionId: null })) });
    show(api);
    await userEvent.click(within(await ask()).getByRole('button', { name: 'Restore' }));
    await screen.findByRole('alert');
    await userEvent.click(within(await ask()).getByRole('button', { name: 'Restore' }));
    await waitFor(() => { expect(screen.getByLabelText('location').textContent).toBe('/p/quarterly-plan-abc123'); });
    expect(of('POST', '/v1/pages/{id}/revisions/{rid}/restore')).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not send twice while the call is on its way: the button is off until the answer is in', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { api, of } = fakeApi({ ...READ, [RESTORE]: async () => { await gate; return ok({ title: 'Quarterly plan', markdown: '# Plan\n', safetyRevisionId: null }); } });
    show(api);
    await userEvent.click(within(await ask()).getByRole('button', { name: 'Restore' }));
    await waitFor(() => { expect(of('POST', '/v1/pages/{id}/revisions/{rid}/restore')).toHaveLength(1); });
    expect((screen.getByRole('button', { name: 'Restore this version' }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => { expect(screen.getByLabelText('location').textContent).toBe('/p/quarterly-plan-abc123'); });
    expect(of('POST', '/v1/pages/{id}/revisions/{rid}/restore')).toHaveLength(1);
  });

  it('stays on the version and can try again after any other refusal (the wrapper has said why)', async () => {
    const { api } = fakeApi({ ...READ, [RESTORE]: { status: 409, body: { error: { code: 'save_failed', message: 'x' } } } });
    show(api);
    await userEvent.click(within(await ask()).getByRole('button', { name: 'Restore' }));
    await waitFor(() => { expect((screen.getByRole('button', { name: 'Restore this version' }) as HTMLButtonElement).disabled).toBe(false); });
    expect(screen.getByLabelText('location').textContent).toBe('/p/quarterly-plan-abc123/history/r1');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stays on the version when the network fails', async () => {
    const { api } = fakeApi({ ...READ, [RESTORE]: () => { throw new Error('offline'); } });
    show(api);
    await userEvent.click(within(await ask()).getByRole('button', { name: 'Restore' }));
    await waitFor(() => { expect((screen.getByRole('button', { name: 'Restore this version' }) as HTMLButtonElement).disabled).toBe(false); });
    expect(screen.getByLabelText('location').textContent).toBe('/p/quarterly-plan-abc123/history/r1');
  });

  it('offers no Restore to a reader: no button of that name, and nothing is sent', async () => {
    const { api, of } = fakeApi({ ...READ });
    show(api, { ...PAGE, myPermission: 'read-only' as never });
    await screen.findByRole('heading', { level: 1, name: 'Quarterly plan' });
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull();
    expect(of('POST', '/v1/pages/{id}/revisions/{rid}/restore')).toHaveLength(0);
  });
});
