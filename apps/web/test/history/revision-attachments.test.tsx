import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linksOf } from '../../src/editor/attachments/host';
import { SessionContext, type Session } from '../../src/auth/session';
import { RevisionBody } from '../../src/screens/history/RevisionBody';
import '../support/dom';

const fakeEditor = { destroy: vi.fn(async () => undefined) };

describe('the text of a version', () => {
  afterEach(cleanup);

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

  it('still draws with no session (a screen on its own)', async () => {
    const mount = vi.fn(async () => fakeEditor as never);
    render(<RevisionBody markdown="text" mount={mount} />);
    await waitFor(() => expect(mount).toHaveBeenCalled());
  });
});
