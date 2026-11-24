import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../../src/editor/core/connection';
import { TEXTS } from '../../src/editor/core/map-signal';
import { decodeHandshake, flush, harness } from './support';

const start = (over: Parameters<typeof harness>[0] = {}) => {
  const h = harness(over);
  const manager = new ConnectionManager(h.options);
  manager.start();
  return { h, manager };
};

describe('opening: the epoch rule', () => {
  it('with an empty document just connects, and sends no e on a first connect', async () => {
    const { h, manager } = start();
    await flush();
    expect(h.sessions).toHaveLength(1);
    expect(h.last().provider.connects).toBe(1);
    expect(decodeHandshake(h.last().provider.tokens[0]!).e).toBeUndefined();
    expect(manager.state().generation).toBe(1);
  });

  it('a tab that holds a document but never learned the epoch (the socket dropped before the epoch message) destroys it and starts a new one before the next connect, sending no e', async () => {
    const { h, manager } = start({ docText: 'text a stale tab holds' });
    // The constructor's first session already holds text and no epoch is recorded: the manager does not connect it, it starts over.
    await flush();
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[0]!.doc.destroyed).toBe(true);
    expect(h.sessions[0]!.provider.destroyed).toBe(true);
    expect(h.sessions[0]!.provider.connects).toBe(0);
    expect(h.sessions[1]!.provider.connects).toBe(1);
    expect(decodeHandshake(h.sessions[1]!.provider.tokens[0]!).e).toBeUndefined();
    expect(manager.state().generation).toBe(2);
  });

  it('does the same on an automatic reconnect: content arrived, the socket dropped before the epoch was recorded', async () => {
    const { h, manager } = start();
    await flush();
    h.last().doc.text = 'synced content';
    h.last().provider.emit({ type: 'status', status: 'disconnected' });
    h.last().provider.close(1006);
    await h.clock.advance(2000); // a close 1006 without a reason waits at least 2 s
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[0]!.doc.destroyed).toBe(true);
    expect(h.sessions[1]!.provider.connects).toBe(1);
    expect(manager.recordedEpoch()).toBeNull();
  });

  it('records the epoch only once the page has synced, and sends it as e from then on, also after a reconnect', async () => {
    const { h, manager } = start();
    await flush();
    const p = h.last().provider;
    p.emit({ type: 'status', status: 'connected' });
    p.stateless({ kind: 'epoch', epoch: 5 });
    expect(manager.recordedEpoch()).toBeNull(); // the message arrived, the page has not synced
    p.emit({ type: 'synced' });
    expect(manager.recordedEpoch()).toBe(5);
    h.last().doc.text = 'content';
    p.close(1001);
    await h.clock.advance(1000);
    expect(h.sessions).toHaveLength(1); // the document is kept: the epoch is recorded
    expect(p.connects).toBe(2);
    await flush();
    expect(decodeHandshake(p.tokens[1]!).e).toBe(5);
  });
});

describe('RETRY and BUSY: the delay', () => {
  it('grows from 1 s, doubling, up to 30 s, and starts over after a sync', async () => {
    const { h } = start();
    await flush();
    const p = h.last().provider;
    const gaps: number[] = [];
    for (let i = 0; i < 7; i++) {
      p.close(1001);
      gaps.push(h.clock.nextIn()!);
      await h.clock.advance(h.clock.nextIn()!);
    }
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    p.succeed(1);
    p.close(1001);
    expect(h.clock.nextIn()).toBe(1000);
  });

  it('jitters the delay by up to half, and never goes below the first delay or above the last', async () => {
    for (const [random, expected] of [
      [0, 500 > 1000 ? 500 : 1000],
      [1, 1500],
    ] as const) {
      const { h } = start({ random });
      await flush();
      h.last().provider.close(1001);
      expect(h.clock.nextIn()).toBe(expected);
    }
  });

  it('waits at least 10 s for a busy server, 30 s for a rate limit, and 2 s for an upgrade-style failure, never faster than the table', async () => {
    const delays = async (signal: (p: ReturnType<typeof harness>['sessions'][number]['provider']) => void) => {
      const { h } = start();
      await flush();
      signal(h.last().provider);
      return h.clock.nextIn();
    };
    expect(await delays((p) => p.refuse('try-again'))).toBe(10_000);
    expect(await delays((p) => p.refuse('page-full'))).toBe(10_000);
    expect(await delays((p) => p.close(4429, 'rate-limited'))).toBe(30_000);
    expect(await delays((p) => p.close(1006))).toBe(2000);
  });

  it('says nothing until it has been offline for more than 10 s, then "Offline: changes kept in this tab", and clears it on connect', async () => {
    const { h, manager } = start();
    await flush();
    h.last().provider.succeed(1);
    h.last().provider.disconnected();
    await h.clock.advance(9999);
    expect(manager.state().text).toBeNull();
    await h.clock.advance(1);
    expect(manager.state()).toMatchObject({ offline: true, text: TEXTS.offline });
    h.last().provider.emit({ type: 'status', status: 'connected' });
    expect(manager.state()).toMatchObject({ offline: false, text: null });
  });
});

describe('the other behaviours', () => {
  it('REFRESH: refreshes the session and connects again; a second refusal within 60 s signs out, and one after 60 s refreshes again', async () => {
    const { h, manager } = start();
    await flush();
    const p = h.last().provider;
    p.refuse('invalid-token');
    await flush();
    expect(h.auth.refreshes).toBe(1);
    expect(p.connects).toBe(2);
    await h.clock.advance(61_000);
    p.close(4401, 'session-expired');
    await flush();
    expect(h.auth.refreshes).toBe(2);
    await h.clock.advance(30_000);
    p.refuse('invalid-token'); // the second for the same cause within 60 s
    await flush();
    expect(h.auth.signOuts).toEqual(['expired']);
    expect(manager.state()).toMatchObject({ phase: 'stopped', stopped: 'sign-out' });
  });

  it('REFRESH: signs out when the refresh itself fails', async () => {
    const { h, manager } = start();
    await flush();
    h.auth.refreshResult = false;
    h.last().provider.refuse('invalid-token');
    await flush();
    expect(h.auth.signOuts).toEqual(['expired']);
    expect(manager.state().stopped).toBe('sign-out');
  });

  it('NO-ACCESS and NOT-FOUND stop, with the text for the first and none for the second', async () => {
    const a = start();
    await flush();
    a.h.last().provider.refuse('forbidden');
    expect(a.manager.state()).toMatchObject({ phase: 'stopped', stopped: 'no-access', text: 'You no longer have access to this page' });
    const b = start();
    await flush();
    b.h.last().provider.refuse('not-found');
    expect(b.manager.state()).toMatchObject({ phase: 'stopped', stopped: 'not-found', text: null });
    expect(a.h.clock.pendingCount()).toBe(0);
  });

  it('RELOAD stops reconnecting for good (client-too-old)', async () => {
    const { h, manager } = start();
    await flush();
    h.last().provider.refuse('client-too-old');
    expect(manager.state()).toMatchObject({ stopped: 'reload', text: 'A new version is available. Reload.' });
    await h.clock.advance(10 * 60_000);
    expect(h.last().provider.connects).toBe(1);
  });

  it('LARGE makes the editor read-only and keeps the connection; READ_ONLY scope does the same with its label', async () => {
    const { h, manager } = start();
    await flush();
    h.last().provider.stateless({ kind: 'refusal', code: 'state-cap' });
    expect(manager.state()).toMatchObject({ readOnly: true, text: TEXTS.tooLarge });
    const other = start();
    await flush();
    other.h.last().provider.emit({ type: 'authenticated', scope: 'readonly' });
    expect(other.manager.state()).toMatchObject({ readOnly: true, text: 'Read only' });
  });

  it('shows the notice of a stateless rate limit and the banner of a state warning, and keeps the connection', async () => {
    const { h, manager } = start();
    await flush();
    h.last().provider.stateless({ kind: 'refusal', code: 'rate-limited' });
    h.last().provider.stateless({ kind: 'warning', code: 'state-warning' });
    expect(manager.state()).toMatchObject({ notice: TEXTS.rateLimitedNotice, banner: TEXTS.stateWarning, phase: 'connecting' });
    expect(h.last().provider.disconnects).toBe(0);
  });

  it('TOKEN: a session token that cannot be had is tried again every 5 s with "Sign-in is unavailable. Trying again."', async () => {
    const { h, manager } = start();
    await flush();
    h.auth.token = null;
    h.last().provider.refuse('Failed to get token during sendToken(): signed out');
    expect(manager.state().text).toBe(TEXTS.signInUnavailable);
    expect(h.clock.nextIn()).toBe(5000);
    await h.clock.advance(5000);
    expect(h.last().provider.connects).toBe(2);
    expect(h.last().provider.failures.length).toBeGreaterThan(0);
  });

  it("FRESH on access-changed: a new document and provider, the old destroyed and never reconnected; the saved document is the screen's read-only view meanwhile", async () => {
    const { h, manager } = start();
    await flush();
    h.last().provider.succeed(2);
    const old = h.last();
    old.doc.text = 'content';
    old.provider.close(4205, 'access-changed');
    await flush();
    expect(old.provider.destroyed).toBe(true);
    expect(old.doc.destroyed).toBe(true);
    expect(h.sessions).toHaveLength(2);
    expect(manager.state().generation).toBe(2);
    expect(h.last().provider.connects).toBe(1);
    expect(
      decodeHandshake(
        h.last().provider.tokens[0] ??
          (await (async () => {
            await flush();
            return h.last().provider.tokens[0]!;
          })()),
      ).e,
    ).toBe(2);
    old.provider.close(1006); // the destroyed provider's late events do nothing
    expect(h.sessions).toHaveLength(2);
  });

  it('ignores the late events of a replaced session even from a provider that keeps talking after it was destroyed', async () => {
    const { h, manager } = start();
    await flush();
    const old = h.last();
    old.provider.leaky = true;
    h.last().provider.succeed(2);
    old.provider.close(4205, 'access-changed'); // FRESH: a second session
    await flush();
    expect(h.sessions).toHaveLength(2);
    const sessionsBefore = h.sessions.length;
    const generation = manager.state().generation;
    old.provider.close(4205, 'access-changed'); // the old provider says it again
    old.provider.refuse('forbidden');
    old.provider.emit({ type: 'synced' });
    await flush();
    expect(h.sessions).toHaveLength(sessionsBefore);
    expect(manager.state()).toMatchObject({ generation, stopped: null });
  });

  it('ignores the events of a session that is gone, and of a manager that was stopped', async () => {
    const { h, manager } = start();
    await flush();
    const p = h.last().provider;
    manager.stop();
    p.emit({ type: 'synced' });
    p.close(4429, 'rate-limited');
    expect(manager.state().phase).toBe('idle');
    expect(h.clock.pendingCount()).toBe(0);
    expect(p.destroyed).toBe(true);
  });

  it('logs the events the table names, by name only', async () => {
    const { h } = start();
    await flush();
    h.last().provider.stateless({ kind: 'refusal', code: 'presence-violation' });
    h.last().provider.refuse('bad-document-name');
    expect(h.logs).toEqual(['web.collab_presence', 'web.collab_error']);
  });
});

describe('with the real clock', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the timers of the platform when none are given: a retry fires after its delay, and the session in use can be read', async () => {
    vi.useFakeTimers();
    const h = harness();
    const { auth, clientVersion, createSession, captureCopy, log } = h.options; // no `timers` and no `random`: the platform's
    const manager = new ConnectionManager({ auth, clientVersion, createSession, captureCopy, log });
    manager.start();
    expect(manager.currentSession()).toBe(h.last());
    await vi.advanceTimersByTimeAsync(0);
    h.last().provider.close(1001);
    await vi.advanceTimersByTimeAsync(500); // the platform's random jitter: never below half the first delay
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.last().provider.connects).toBe(2);
    manager.stop();
    expect(manager.currentSession()).toBeNull();
  });
});

describe('what the first review found', () => {
  it('a read-only session that is replaced does not leave the new one locked: a reader who was upgraded can type, and so can a page that was too large and was recreated', async () => {
    const reader = start();
    await flush();
    reader.h.last().provider.emit({ type: 'authenticated', scope: 'readonly' });
    expect(reader.manager.state()).toMatchObject({ readOnly: true, text: TEXTS.readOnly });
    reader.h.last().provider.emit({ type: 'authenticated', scope: 'read-write' }); // upgraded: the next connect signs in with the right to write
    expect(reader.manager.state()).toMatchObject({ readOnly: false, text: null });

    const large = start();
    await flush();
    large.h.last().provider.succeed(2);
    large.h.last().provider.stateless({ kind: 'refusal', code: 'state-cap' });
    expect(large.manager.state().readOnly).toBe(true);
    large.h.last().provider.close(4205, 'access-changed'); // a new session for the same page
    await flush();
    expect(large.manager.state()).toMatchObject({ readOnly: false, text: null });
  });

  it('keeps the reset notice with the copy through the sync of the reopened page, and drops it with the copy', async () => {
    const { h, manager } = start();
    await flush();
    h.last().provider.succeed(3);
    h.last().doc.text = 'unsent edits';
    h.last().provider.close(4409, 'stale-epoch');
    await flush();
    h.last().provider.succeed(4);
    expect(manager.state()).toMatchObject({ notice: TEXTS.reset, copy: 'unsent edits' });
    manager.dismissCopy();
    expect(manager.state()).toMatchObject({ notice: null, copy: null });
  });

  it('a refusal of the token and the close that follows it a moment later are one event: one refresh, no sign-out, one reconnect', async () => {
    const { h, manager } = start();
    await flush();
    const p = h.last().provider;
    p.refuse('invalid-token');
    p.close(4401, 'invalid-token'); // the server closes the socket about 250 ms after the refusal
    await flush();
    expect(h.auth.refreshes).toBe(1);
    expect(h.auth.signOuts).toEqual([]);
    expect(p.connects).toBe(2);
    expect(manager.state().stopped).toBeNull();
  });

  it('a second signal while a refresh is still running does not start another', async () => {
    const { h } = start();
    await flush();
    let finish: (ok: boolean) => void = () => undefined;
    h.auth.refresh = () => new Promise<boolean>((resolve) => void (finish = resolve));
    const p = h.last().provider;
    p.refuse('invalid-token');
    h.clock.advance(5000); // not within the pairing window of a close: a second refusal of its own
    p.refuse('invalid-token');
    finish(true);
    await flush();
    expect(h.auth.signOuts).toEqual([]);
    expect(p.connects).toBe(2);
  });

  it('a refresh that finishes after the page was stopped does not reconnect it', async () => {
    const { h, manager } = start();
    await flush();
    let finish: (ok: boolean) => void = () => undefined;
    h.auth.refresh = () => new Promise<boolean>((resolve) => void (finish = resolve));
    const p = h.last().provider;
    p.refuse('invalid-token');
    p.refuse('forbidden'); // the page is stopped while the refresh runs
    expect(manager.state().stopped).toBe('no-access');
    finish(true);
    await flush();
    expect(p.connects).toBe(1);
    expect(manager.state()).toMatchObject({ phase: 'stopped', stopped: 'no-access' });
  });

  it("a close that follows a stop or an error wait is the manager's own doing: a stopped page stays stopped, and the error wait is not replaced by a retry", async () => {
    const stopped = start();
    await flush();
    stopped.h.last().provider.refuse('forbidden');
    stopped.h.last().provider.close(1006); // what disconnect() looks like from the provider
    stopped.h.last().provider.close(1000);
    await stopped.h.clock.advance(10 * 60_000);
    expect(stopped.manager.state()).toMatchObject({ phase: 'stopped', stopped: 'no-access' });
    expect(stopped.h.last().provider.connects).toBe(1);

    const waiting = start();
    await flush();
    waiting.h.last().provider.refuse('internal-error');
    waiting.h.last().provider.close(1006);
    expect(waiting.h.clock.pendingCount()).toBe(1);
    expect(waiting.h.clock.nextIn()).toBe(30_000); // still the 30 s of the error, not a 2 s retry
  });

  it('keeps the read-only label and the too-large text through the sync that follows, and drops other texts', async () => {
    const reader = start();
    await flush();
    reader.h.last().provider.emit({ type: 'authenticated', scope: 'readonly' });
    reader.h.last().provider.emit({ type: 'synced' });
    expect(reader.manager.state()).toMatchObject({ readOnly: true, text: TEXTS.readOnly });
    const large = start();
    await flush();
    large.h.last().provider.stateless({ kind: 'refusal', code: 'state-cap' });
    large.h.last().provider.emit({ type: 'synced' });
    expect(large.manager.state()).toMatchObject({ readOnly: true, text: TEXTS.tooLarge });
  });

  it('a new document starts without the banner and the offline state of the old one', async () => {
    const { h, manager } = start();
    await flush();
    h.last().provider.succeed(2);
    h.last().provider.stateless({ kind: 'warning', code: 'state-warning' });
    h.last().provider.disconnected();
    await h.clock.advance(10_000);
    expect(manager.state()).toMatchObject({ banner: TEXTS.stateWarning, offline: true });
    h.last().provider.close(4205, 'access-changed');
    await flush();
    expect(manager.state()).toMatchObject({ banner: null, offline: false });
  });

  it('a reconnect of the same session after the page was too large does not unlock the editor', async () => {
    const { h, manager } = start();
    await flush();
    h.last().provider.succeed(2);
    h.last().provider.stateless({ kind: 'refusal', code: 'state-cap' });
    h.last().provider.close(1001);
    await h.clock.advance(1000);
    h.last().provider.emit({ type: 'authenticated', scope: 'read-write' });
    expect(manager.state()).toMatchObject({ readOnly: true, text: TEXTS.tooLarge });
  });

  it('a refresh still running for a replaced session does not swallow the refusal of the new one: it is refreshed and reconnected', async () => {
    const { h, manager } = start();
    await flush();
    h.last().provider.succeed(2);
    const gates: ((ok: boolean) => void)[] = [];
    h.auth.refresh = () => new Promise<boolean>((resolve) => void gates.push(resolve));
    h.last().provider.refuse('invalid-token'); // refresh 1 runs for session 1
    h.last().provider.close(4205, 'access-changed'); // ... which is replaced by a new session meanwhile
    await flush();
    expect(h.sessions).toHaveLength(2);
    await h.clock.advance(61_000);
    h.last().provider.refuse('invalid-token'); // the new session is refused: its own refresh
    expect(gates).toHaveLength(2);
    gates[0]!(true); // the old one finishes: nothing to do for the replaced session
    gates[1]!(true);
    await flush();
    expect(h.last().provider.connects).toBe(2);
    expect(manager.state().stopped).toBeNull();
  });

  it('the close of our own disconnect while a refresh runs schedules no retry: the connect waits for the new token, once', async () => {
    const { h } = start();
    await flush();
    let finish: (ok: boolean) => void = () => undefined;
    h.auth.refresh = () => new Promise<boolean>((resolve) => void (finish = resolve));
    const p = h.last().provider;
    p.refuse('invalid-token');
    p.close(1006); // what disconnect() looks like from the provider
    expect(h.clock.pendingCount()).toBe(0);
    await h.clock.advance(60_000);
    expect(p.connects).toBe(1); // no connect with the token being replaced
    finish(true);
    await flush();
    expect(p.connects).toBe(2);
  });
});
