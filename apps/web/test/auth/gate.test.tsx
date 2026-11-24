import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadServerConfig } from '../../src/gate/config';
import { Gate } from '../../src/gate/Gate';
import { GATE_MESSAGES, GATE_RETRY_MS } from '../../src/gate/messages';
import { resetClientOutdated } from '../../src/gate/outdated';
import { config } from './support';

afterEach(() => {
  cleanup();
  resetClientOutdated();
  vi.useRealTimers();
});

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** The gate with a scripted server: each call takes the next reply (an Error is a network failure); the last one repeats. */
function scripted(replies: (Response | Error)[]) {
  let i = 0;
  const fetchFn = vi.fn(async () => {
    const next = replies[Math.min(i++, replies.length - 1)]!;
    if (next instanceof Error) throw next;
    return next.clone();
  });
  return fetchFn;
}
const app = () => <p>the app</p>;

describe('the configuration gate', () => {
  it('renders only "A new version is available. Reload." when the minimum client version is above this client (9.0.0 against 1.2.3)', async () => {
    const fetchFn = scripted([answer(config({ minClientVersion: '9.0.0' }))]);
    render(<Gate options={{ apiUrl: 'http://api', fetch: fetchFn as never, clientVersion: '1.2.3' }}>{app}</Gate>);
    expect(await screen.findByText(GATE_MESSAGES.outdated)).toBeTruthy();
    expect(screen.queryByText('the app')).toBeNull();
    expect(document.body.textContent).toBe(GATE_MESSAGES.outdated);
  });

  it('renders the app, with the configuration, when the minimum is 0.0.0', async () => {
    const fetchFn = scripted([answer(config({ minClientVersion: '0.0.0', collabUrl: 'ws://c' }))]);
    render(<Gate options={{ apiUrl: 'http://api', fetch: fetchFn as never, clientVersion: '1.2.3' }}>{(c) => <p>{`the app ${c.collabUrl}`}</p>}</Gate>);
    expect(await screen.findByText('the app ws://c')).toBeTruthy();
  });

  it('renders the app when the client equals the minimum, and not when it is one patch below', async () => {
    const equal = scripted([answer(config({ minClientVersion: '1.2.3' }))]);
    const { unmount } = render(<Gate options={{ apiUrl: 'http://api', fetch: equal as never, clientVersion: '1.2.3' }}>{app}</Gate>);
    expect(await screen.findByText('the app')).toBeTruthy();
    unmount();
    const below = scripted([answer(config({ minClientVersion: '1.2.4' }))]);
    render(<Gate options={{ apiUrl: 'http://api', fetch: below as never, clientVersion: '1.2.3' }}>{app}</Gate>);
    expect(await screen.findByText(GATE_MESSAGES.outdated)).toBeTruthy();
  });

  it('shows "The server can\'t be reached. Trying again." on a network error and asks again every 5 s until the server answers', async () => {
    vi.useFakeTimers();
    const fetchFn = scripted([new TypeError('network'), new TypeError('network'), answer(config())]);
    render(<Gate options={{ apiUrl: 'http://api', fetch: fetchFn as never }}>{app}</Gate>);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(screen.getByText(GATE_MESSAGES.unreachable)).toBeTruthy();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(GATE_RETRY_MS - 1)));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(screen.getByText(GATE_MESSAGES.unreachable)).toBeTruthy();
    await act(async () => void (await vi.advanceTimersByTimeAsync(GATE_RETRY_MS)));
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(screen.getByText('the app')).toBeTruthy();
    expect(GATE_RETRY_MS).toBe(5000);
  });

  it('shows "The server is not ready. Trying again." on 503, then the app once it answers', async () => {
    vi.useFakeTimers();
    const fetchFn = scripted([answer({ error: { code: 'unavailable' } }, 503), answer(config())]);
    render(<Gate options={{ apiUrl: 'http://api', fetch: fetchFn as never }}>{app}</Gate>);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(screen.getByText(GATE_MESSAGES.notReady)).toBeTruthy();
    await act(async () => void (await vi.advanceTimersByTimeAsync(GATE_RETRY_MS)));
    expect(screen.getByText('the app')).toBeTruthy();
  });

  it('asks without credentials and with the client version header, and treats an answer that is not a configuration as unreachable', async () => {
    const fetchFn = scripted([answer({ nonsense: true })]);
    const states: string[] = [];
    const sleep = vi.fn(async () => Promise.reject(new Error('stop')));
    await expect(loadServerConfig({ apiUrl: 'http://api', fetch: fetchFn as never, sleep, clientVersion: '1.2.3' }, (s) => states.push(s.kind))).rejects.toThrow('stop');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api/v1/config');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ 'X-Grimoire-Client-Version': '1.2.3' });
    expect(states).toEqual(['unreachable']);
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('treats a 426 answer to the configuration request as an outdated client', async () => {
    const fetchFn = scripted([answer({ error: { code: 'client_too_old' } }, 426)]);
    expect((await loadServerConfig({ apiUrl: 'http://api', fetch: fetchFn as never })).kind).toBe('outdated');
  });

  it('stops asking when the gate goes away', async () => {
    vi.useFakeTimers();
    const fetchFn = scripted([new TypeError('network')]);
    const { unmount } = render(<Gate options={{ apiUrl: 'http://api', fetch: fetchFn as never }}>{app}</Gate>);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    const before = fetchFn.mock.calls.length;
    unmount();
    await act(async () => void (await vi.advanceTimersByTimeAsync(GATE_RETRY_MS * 3)));
    expect(fetchFn.mock.calls.length).toBe(before);
  });
});
