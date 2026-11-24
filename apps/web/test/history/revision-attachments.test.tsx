import { act, cleanup, render, waitFor } from '@testing-library/react';
import { mountReadOnly } from '../../src/editor/core/mount';
import { Toaster } from '../../src/ui/primitives';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linksOf } from '../../src/editor/attachments/host';
import { SessionContext, type Session } from '../../src/auth/session';
import { RevisionBody } from '../../src/screens/history/RevisionBody';
import '../support/dom';

const fakeEditor = { destroy: vi.fn(async () => undefined) };

describe('the text of a version', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks(); // a spy of one test (the new tab) never reaches the next
  });

  it('gives the editor that draws it the links of the session, so the uploaded images of an old version load, and takes them back', async () => {
    const POST = vi.fn(async () => ({ data: { urls: [] }, response: new Response('{}', { status: 200 }) }));
    const session = { auth: {}, api: { POST }, collabUrl: 'ws://x' } as unknown as Session;
    let seen: { host: HTMLElement; links: boolean } | null = null;
    const mount = vi.fn(async (host: HTMLElement) => {
      seen = { host, links: linksOf(host) !== null };
      return fakeEditor as never;
    });
    const view = render(
      <SessionContext.Provider value={session}>
        <RevisionBody markdown="![a](attachments/3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b/a.png)" mount={mount} />
      </SessionContext.Provider>,
    );
    await waitFor(() => expect(seen).not.toBeNull());
    expect(seen!.links).toBe(true);
    const host = seen!.host;
    view.unmount();
    expect(linksOf(host)).toBeNull();
  });

  it('opens an attachment link of an old version: a click asks for its signed link at that moment and opens it, and a missing file is said', async () => {
    const id = '3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b';
    const GET = vi.fn(async () => ({ data: { url: 'https://files.test/signed?download' }, response: new Response('{}', { status: 200 }) }));
    const session = { auth: {}, api: { POST: vi.fn(), GET }, collabUrl: 'ws://x' } as unknown as Session;
    const tab = { opener: 'x' as unknown, location: { replace: vi.fn() }, close: vi.fn() };
    const opener = vi.spyOn(window, 'open').mockReturnValue(tab as never);
    const view = render(
      <SessionContext.Provider value={session}>
        <RevisionBody markdown={`[the plan](attachments/${id}/plan.pdf)`} mount={mountReadOnly} />
        <Toaster />
      </SessionContext.Provider>,
    );
    const link = await view.findByRole('link', { name: 'the plan' });
    expect(GET).not.toHaveBeenCalled(); // nothing is asked for before the click
    act(() => { link.click(); });
    expect(opener).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith('https://files.test/signed?download'));
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith('/v1/attachments/{id}', { params: { path: { id }, query: { download: true } } });
    // A file that is gone: the tab is closed and the person is told (the toast of the page).
    GET.mockResolvedValueOnce({ error: {}, response: new Response('{}', { status: 404 }) } as never);
    act(() => { link.click(); });
    await waitFor(() => expect(tab.close).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.body.textContent).toContain("That file isn't available"));
  });

  it('still draws with no session (a screen on its own)', async () => {
    const mount = vi.fn(async () => fakeEditor as never);
    render(<RevisionBody markdown="text" mount={mount} />);
    await waitFor(() => expect(mount).toHaveBeenCalled());
  });
});
