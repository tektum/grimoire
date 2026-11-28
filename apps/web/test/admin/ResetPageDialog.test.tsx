import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ResetPageDialog } from '../../src/screens/admin/ResetPageDialog';
import '../support/dom';
import { fakeApi, ok, renderAt } from './support';

const PAGE = { id: 'p1', title: 'Quarterly plan' };
const URL = '/v1/pages/{id}/reset-state';
const stale = { status: 409, body: { error: { code: 'markdown_stale', message: 'x' } } };

function Host({ api }: { readonly api: ReturnType<typeof fakeApi>['api'] }) {
  const [open, setOpen] = useState(true);
  return <><button onClick={() => { setOpen(true); }}>Reopen</button><ResetPageDialog api={api} page={PAGE} open={open} onOpenChange={setOpen} /></>;
}
const show = (api: ReturnType<typeof fakeApi>['api']) => renderAt(<Host api={api} />);
const dialog = () => screen.findByRole('dialog', { name: 'Reset the saved state of Quarterly plan?' });

describe('the reset-state dialog', () => {
  it('asks first, naming the page, and sends nothing until it is confirmed', async () => {
    const { api, requests } = fakeApi({});
    show(api);
    const d = await dialog();
    expect(within(d).getByText(/rebuilt from its saved Markdown/)).toBeTruthy();
    expect(requests).toEqual([]);
  });

  it('resets once, with no body fields by default, and says the page was reset', async () => {
    const { api, of } = fakeApi({ [`POST ${URL}`]: ok({ stateEpoch: 3, markdownStale: false }) });
    show(api);
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Reset state' }));
    expect(await screen.findByText('The state of Quarterly plan was reset.')).toBeTruthy();
    expect(of('POST', URL)).toHaveLength(1);
    expect(of('POST', URL)[0]).toMatchObject({ params: { path: { id: 'p1' } }, body: {} });
    expect(screen.queryByText(/older/)).toBeNull();
  });

  it('sends the replacement Markdown when one is given', async () => {
    const { api, of } = fakeApi({ [`POST ${URL}`]: ok({ stateEpoch: 3, markdownStale: false }) });
    show(api);
    await userEvent.type(within(await dialog()).getByRole('textbox', { name: 'Replacement Markdown (optional)' }), '# New{Enter}text');
    // A reset with a replacement loses what the page holds: its verb is the destructive one, as the confirmation's is.
    const button = screen.getByRole('button', { name: 'Reset state' });
    expect(button.getAttribute('data-variant')).toBe('destructive');
    await userEvent.click(button);
    await screen.findByText('The state of Quarterly plan was reset.');
    expect(of('POST', URL)[0]?.body).toEqual({ markdown: '# New\ntext' });
  });

  it('treats whitespace alone as no replacement: the request carries none, and the verb keeps the accent', async () => {
    const { api, of } = fakeApi({ [`POST ${URL}`]: ok({ stateEpoch: 3, markdownStale: false }) });
    show(api);
    await userEvent.type(within(await dialog()).getByRole('textbox', { name: 'Replacement Markdown (optional)' }), '   ');
    const button = screen.getByRole('button', { name: 'Reset state' });
    expect(button.getAttribute('data-variant')).toBe('primary');
    await userEvent.click(button);
    await screen.findByText('The state of Quarterly plan was reset.');
    expect(of('POST', URL)[0]?.body).toEqual({});
  });

  it('says the saved text was older when the answer says so', async () => {
    const { api } = fakeApi({ [`POST ${URL}`]: ok({ stateEpoch: 3, markdownStale: true }) });
    show(api);
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Reset state' }));
    expect(await screen.findByText(/its saved text was older than its state/i)).toBeTruthy();
  });

  it('does not send twice while the call is on its way', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { api, of } = fakeApi({ [`POST ${URL}`]: async () => { await gate; return ok({ stateEpoch: 3, markdownStale: false }); } });
    show(api);
    const button = within(await dialog()).getByRole('button', { name: 'Reset state' });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(of('POST', URL)).toHaveLength(1); // held open: the second press found the call still on its way
    release();
    await screen.findByText('The state of Quarterly plan was reset.');
    expect(of('POST', URL)).toHaveLength(1);
  });

  it('ignores an answer that arrives after the dialog was closed: reopened, it asks the question again with no stale warning', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { api } = fakeApi({ [`POST ${URL}`]: async () => { await gate; return stale; } });
    show(api);
    await userEvent.type(within(await dialog()).getByRole('textbox', { name: 'Replacement Markdown (optional)' }), 'typed');
    await userEvent.click(screen.getByRole('button', { name: 'Reset state' }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Close' })[0] as HTMLElement);
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    release();
    await waitFor(() => { expect((screen.getByRole('button', { name: 'Reopen' }) as HTMLButtonElement).disabled).toBe(false); });
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    const d = await dialog();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((within(d).getByRole('textbox', { name: 'Replacement Markdown (optional)' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('on markdown_stale warns that the newest edits would be lost, and sends nothing until that is confirmed too', async () => {
    const { api, of } = fakeApi({ [`POST ${URL}`]: (r) => ((r.body as { confirmStale?: boolean }).confirmStale === true ? ok({ stateEpoch: 4, markdownStale: true }) : stale) });
    show(api);
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Reset state' }));
    const warning = await screen.findByRole('alertdialog', { name: 'The saved text is older than the page' });
    expect(within(warning).getByText(/newest edits would be lost/)).toBeTruthy();
    expect(within(warning).getByText(/saved Markdown/)).toBeTruthy();
    expect(of('POST', URL)).toHaveLength(1);
    await userEvent.click(within(warning).getByRole('button', { name: 'Reset anyway' }));
    expect(await screen.findByText(/its saved text was older than its state/i)).toBeTruthy();
    expect(of('POST', URL)).toHaveLength(2);
    expect(of('POST', URL)[1]?.body).toEqual({ confirmStale: true });
  });

  it('goes back from the stale warning without sending anything more', async () => {
    const { api, of } = fakeApi({ [`POST ${URL}`]: stale });
    show(api);
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Reset state' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await dialog()).toBeTruthy();
    expect(of('POST', URL)).toHaveLength(1);
  });

  it('shows the server\'s words for a replacement it refuses (422), and stays open to edit it', async () => {
    const { api } = fakeApi({ [`POST ${URL}`]: { status: 422, body: { error: { code: 'invalid', message: 'The text is over 131072 bytes' } } } });
    show(api);
    await userEvent.type(within(await dialog()).getByRole('textbox', { name: 'Replacement Markdown (optional)' }), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Reset state' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The text is over 131072 bytes');
    expect(await dialog()).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Reset state' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says it did not work, in words, for any other refusal, and can be tried again', async () => {
    let attempt = 0;
    const { api, of } = fakeApi({ [`POST ${URL}`]: () => (attempt++ === 0 ? { status: 503 } : ok({ stateEpoch: 3, markdownStale: false })) });
    show(api);
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Reset state' }));
    expect((await screen.findByRole('alert')).textContent).toBe("The state wasn't reset. Try again.");
    await userEvent.click(screen.getByRole('button', { name: 'Reset state' }));
    await screen.findByText('The state of Quarterly plan was reset.');
    expect(of('POST', URL)).toHaveLength(2);
  });

  it('says it did not work when the network fails', async () => {
    const { api } = fakeApi({ [`POST ${URL}`]: () => { throw new Error('offline'); } });
    show(api);
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Reset state' }));
    expect((await screen.findByRole('alert')).textContent).toBe("The state wasn't reset. Try again.");
  });

  it('starts again from the question when it is reopened after a reset', async () => {
    const { api } = fakeApi({ [`POST ${URL}`]: ok({ stateEpoch: 3, markdownStale: false }) });
    show(api);
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Reset state' }));
    await screen.findByText('The state of Quarterly plan was reset.');
    await userEvent.click(screen.getAllByRole('button', { name: 'Close' })[0] as HTMLElement);
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(await dialog()).toBeTruthy();
    expect(screen.queryByText('The state of Quarterly plan was reset.')).toBeNull();
  });
});
