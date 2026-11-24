import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MountedEditor } from '../../src/editor/core/mount';
import { RevisionView } from '../../src/screens/history/RevisionView';
import '../support/dom';
import { fakeApi, ok, PAGE, renderAt, rev } from './support';

const ONE = 'GET /v1/pages/{id}/revisions/{rid}';
const CURRENT = 'GET /v1/pages/{id}/markdown';
const OLD = '# Plan\n\nThe older text\nEnd\n';
const NOW = '# Plan\n\nThe newer text\nEnd\n';
const routes = () => ({ [ONE]: ok({ ...rev('r1'), markdown: OLD }), [CURRENT]: ok(NOW) });

/** A read-only editor that is only a recorder: a real one needs a browser. */
function fakeMount() {
  const destroyed: string[] = [];
  const mount = vi.fn(async (element: HTMLElement, markdown: string): Promise<MountedEditor> => {
    const root = document.createElement('div');
    root.className = 'ProseMirror';
    root.textContent = markdown;
    element.append(root);
    return { setEditable: () => undefined, markdown: () => markdown, applyMarkdown: () => undefined, destroy: async () => { destroyed.push(markdown); element.remove(); } };
  });
  return { mount, destroyed };
}
const show = (api: ReturnType<typeof fakeApi>['api'], mount = fakeMount().mount, id = 'r1') =>
  renderAt(<RevisionView api={api} page={PAGE} slug="quarterly-plan-abc123" revisionId={id} mount={mount} />, `/p/quarterly-plan-abc123/history/${id}`);

describe('one revision', () => {
  it('reads the revision and the current page as text, and shows when it was kept, why, and who edited', async () => {
    const { api, of } = fakeApi(routes());
    show(api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Quarterly plan' })).toBeTruthy();
    expect(screen.getByText('Saved after editing stopped')).toBeTruthy();
    expect(screen.getByText(/Alice Example/)).toBeTruthy();
    expect(of('GET', '/v1/pages/{id}/revisions/{rid}')[0]?.params.path).toEqual({ id: 'p1', rid: 'r1' });
    await waitFor(() => { expect(of('GET', '/v1/pages/{id}/markdown')).toHaveLength(1); });
    expect(of('GET', '/v1/pages/{id}/markdown')[0]).toMatchObject({ params: { path: { id: 'p1' } }, parseAs: 'text' });
  });

  it("shows the revision's Markdown through the read-only editor, and takes the editor down when it leaves", async () => {
    const { api } = fakeApi(routes());
    const { mount, destroyed } = fakeMount();
    const view = show(api, mount);
    await waitFor(() => { expect(mount).toHaveBeenCalledTimes(1); });
    expect(mount.mock.calls[0]?.[1]).toBe(OLD);
    expect(screen.getByTestId('revision-text').textContent).toContain('The older text');
    view.unmount();
    await waitFor(() => { expect(destroyed).toEqual([OLD]); });
  });

  it('names the editor for assistive technology, so a text field is never nameless', async () => {
    const { api } = fakeApi(routes());
    show(api);
    await waitFor(() => { expect(screen.getByTestId('revision-text').querySelector('.ProseMirror')?.getAttribute('aria-label')).toBe('Text of this version'); });
  });

  it('shows the line diff against the current page under Changes: what restoring would remove and add', async () => {
    const { api } = fakeApi(routes());
    show(api);
    await userEvent.click(await screen.findByRole('tab', { name: 'Changes' }));
    const panel = await screen.findByRole('tabpanel');
    expect(Array.from(panel.querySelectorAll('del')).map((e) => e.textContent)).toEqual([expect.stringContaining('The newer text')]);
    expect(Array.from(panel.querySelectorAll('ins')).map((e) => e.textContent)).toEqual([expect.stringContaining('The older text')]);
    expect(within(panel).getByText(/Restoring this version would remove the lines marked Removed and add the lines marked Added/)).toBeTruthy();
  });

  it('goes back to the text from Changes, building the editor again and taking the first one down', async () => {
    const { api } = fakeApi(routes());
    const { mount, destroyed } = fakeMount();
    show(api, mount);
    await waitFor(() => { expect(mount).toHaveBeenCalledTimes(1); });
    await userEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Text' }));
    await waitFor(() => { expect(mount).toHaveBeenCalledTimes(2); });
    expect(destroyed).toEqual([OLD]);
    expect(screen.getByRole('tab', { name: 'Text' }).getAttribute('aria-selected')).toBe('true');
  });

  it('stays usable when the editor cannot be built: the page and the Changes tab still work', async () => {
    const { api } = fakeApi(routes());
    const mount = vi.fn(async (): Promise<MountedEditor> => { throw new Error('no editor'); });
    show(api, mount);
    await waitFor(() => { expect(mount).toHaveBeenCalled(); });
    await userEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(await screen.findByText(/Restoring this version would remove/)).toBeTruthy();
  });

  it('takes down an editor that finishes building after the view has left', async () => {
    const { api } = fakeApi(routes());
    let finish: (editor: MountedEditor) => void = () => undefined;
    const late = new Promise<MountedEditor>((resolve) => { finish = resolve; });
    const destroyed: string[] = [];
    const view = show(api, vi.fn(() => late));
    await screen.findByRole('heading', { level: 1, name: 'Quarterly plan' });
    view.unmount();
    finish({ setEditable: () => undefined, markdown: () => '', applyMarkdown: () => undefined, destroy: async () => { destroyed.push('late'); } });
    await waitFor(() => { expect(destroyed).toEqual(['late']); });
  });

  it('keeps nothing of the document in the query cache after it leaves (R11.5)', async () => {
    const { api } = fakeApi(routes());
    const view = show(api);
    await screen.findByRole('heading', { level: 1, name: 'Quarterly plan' });
    await waitFor(() => { expect(view.client.getQueryCache().getAll().filter((q) => q.state.data !== undefined)).toHaveLength(2); });
    view.unmount();
    await waitFor(() => { expect(view.client.getQueryCache().getAll()).toHaveLength(0); });
  });

  it('shows the not-found screen when the revision answers 404', async () => {
    const { api } = fakeApi({ [ONE]: { status: 404 }, [CURRENT]: ok(NOW) });
    show(api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
  });

  it('does not compare with a page whose saved text is behind its live content: it says so, with Try again, and never claims what restoring would remove', async () => {
    let attempt = 0;
    const { api } = fakeApi({
      [ONE]: ok({ ...rev('r1'), markdown: OLD }),
      [CURRENT]: () => (attempt++ === 0 ? { status: 200, body: '', headers: { 'x-grimoire-markdown-stale': 'true' } } : ok(NOW)),
    });
    show(api);
    await userEvent.click(await screen.findByRole('tab', { name: 'Changes' }));
    const note = await screen.findByRole('status');
    expect(note.textContent).toContain('still being saved');
    expect(screen.queryByText(/Restoring this version would remove/)).toBeNull();
    expect(screen.getByRole('tabpanel').querySelectorAll('ins, del')).toHaveLength(0);
    await userEvent.click(within(note).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Restoring this version would remove/)).toBeTruthy();
    expect(screen.getByRole('tabpanel').querySelectorAll('ins, del').length).toBeGreaterThan(0);
  });

  it('keeps the text and says the comparison failed, with Try again, when the current page cannot be read', async () => {
    let attempt = 0;
    const { api } = fakeApi({ [ONE]: ok({ ...rev('r1'), markdown: OLD }), [CURRENT]: () => (attempt++ === 0 ? { status: 503 } : ok(NOW)) });
    show(api);
    await userEvent.click(await screen.findByRole('tab', { name: 'Changes' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't compare with the page");
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => { expect(screen.getByRole('tabpanel').querySelectorAll('ins, del').length).toBeGreaterThan(0); });
  });

  it('treats a current page that does not come back as text as a failed comparison, not as an empty page', async () => {
    const { api } = fakeApi({ [ONE]: ok({ ...rev('r1'), markdown: OLD }), [CURRENT]: ok({ unexpected: true }) });
    show(api);
    await userEvent.click(await screen.findByRole('tab', { name: 'Changes' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't compare with the page");
    expect(screen.getByRole('tabpanel').querySelectorAll('ins, del')).toHaveLength(0);
    expect(screen.queryByText(/Restoring this version would remove/)).toBeNull();
  });

  it('treats an empty 200 answer as an empty page: the changes are every line of the version added', async () => {
    const { api } = fakeApi({ [ONE]: ok({ ...rev('r1'), markdown: OLD }), [CURRENT]: ok(undefined) });
    show(api);
    await userEvent.click(await screen.findByRole('tab', { name: 'Changes' }));
    const panel = await screen.findByRole('tabpanel');
    await waitFor(() => { expect(panel.querySelectorAll('ins').length).toBeGreaterThan(0); });
    expect(panel.querySelectorAll('del')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('calls a version with no title Untitled, so the section has a name', async () => {
    const { api } = fakeApi({ [ONE]: ok({ ...rev('r1', { title: '' }), markdown: OLD }), [CURRENT]: ok(NOW) });
    show(api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Untitled' })).toBeTruthy();
  });

  it('offers to try again when the revision cannot be read', async () => {
    let attempt = 0;
    const { api } = fakeApi({ [ONE]: () => (attempt++ === 0 ? { status: 503 } : ok({ ...rev('r1'), markdown: OLD })), [CURRENT]: ok(NOW) });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Quarterly plan' })).toBeTruthy();
  });

  it('has a way back to the list', async () => {
    const { api } = fakeApi(routes());
    show(api);
    expect((await screen.findByRole('link', { name: 'All versions' })).getAttribute('href')).toBe('/p/quarterly-plan-abc123/history');
  });
});
