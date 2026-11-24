import { describe, expect, it } from 'vitest';
import { type Mapping, mapSignal, type Signal, TEXTS } from '../../src/editor/core/map-signal';

interface Row {
  /** The row of the table in contracts section 6, by its first cell. */
  readonly id: string;
  readonly signals: readonly Signal[];
  readonly expected: Partial<Mapping> & Pick<Mapping, 'behaviour'>;
}
const refused = (reason: string): Signal => ({ type: 'authenticationFailed', reason });
const closed = (code: number, reason?: string): Signal => ({ type: 'close', code, ...(reason === undefined ? {} : { reason }) });
const stateless = (message: Record<string, unknown>): Signal => ({ type: 'stateless', payload: JSON.stringify({ grimoire: 1, ...message }) });

/** Every row of the table, with each way the signal can reach the client. A row that is not here, or not mapped, fails the test below. */
const ROWS: readonly Row[] = [
  {
    id: 'bad-document-name; 4400',
    signals: [refused('bad-document-name'), closed(4400)],
    expected: { behaviour: 'ERROR', noRetry: true, text: 'Something went wrong opening this page. Reload.', log: 'web.collab_error' },
  },
  { id: 'invalid-token; 4401, session-expired; 4401', signals: [refused('invalid-token'), closed(4401, 'session-expired'), closed(4401)], expected: { behaviour: 'REFRESH' } },
  { id: 'forbidden; 4403', signals: [refused('forbidden'), closed(4403)], expected: { behaviour: 'NO_ACCESS', text: 'You no longer have access to this page' } },
  { id: 'not-found; 4404', signals: [refused('not-found'), closed(4404)], expected: { behaviour: 'NOT_FOUND' } },
  { id: 'page-full; 4413', signals: [refused('page-full'), closed(4413)], expected: { behaviour: 'BUSY', minDelayMs: 10_000, text: 'This page already has 100 people editing. Try again in a moment.' } },
  ...['server-full', 'documents-full', 'memory-guard', 'try-again'].map((reason): Row => ({
    id: `${reason}; 4503`,
    signals: [refused(reason), closed(4503)],
    expected: { behaviour: 'BUSY', minDelayMs: 10_000, text: 'The server is busy. Trying again.' },
  })),
  ...['state-corrupt', 'internal-error'].map((reason): Row => ({
    id: `${reason}; 4500`,
    signals: [refused(reason), closed(4500)],
    expected: { behaviour: 'ERROR', text: "This page can't be opened right now. Trying again." },
  })),
  { id: 'seed-failed; 4501', signals: [refused('seed-failed'), closed(4501)], expected: { behaviour: 'ERROR', noRetry: true, text: "This page can't be opened right now. Trying again." } },
  { id: 'any unknown reason', signals: [refused('something-new'), refused('')], expected: { behaviour: 'ERROR', text: "This page can't be opened right now. Trying again." } },
  { id: 'close reason access-changed; 4205', signals: [closed(4205, 'access-changed'), closed(4205), closed(1000, 'access-changed')], expected: { behaviour: 'FRESH' } },
  {
    id: 'close rate-limited; 4429',
    signals: [closed(4429, 'rate-limited'), closed(4429)],
    expected: { behaviour: 'BUSY', minDelayMs: 30_000, text: 'You are sending changes faster than the server accepts. Trying again.' },
  },
  { id: '1009 (raw message too big)', signals: [closed(1009)], expected: { behaviour: 'LARGE', text: 'This page is too large to edit further. You can still read it.' } },
  { id: 'stateless state-cap', signals: [stateless({ kind: 'refusal', code: 'state-cap' })], expected: { behaviour: 'LARGE', text: 'This page is too large to edit further. You can still read it.' } },
  ...[4408, 1001].map((code): Row => ({ id: `close ${code}`, signals: [closed(code)], expected: { behaviour: 'RETRY' } })),
  { id: '1006 and any close not listed', signals: [closed(1006), closed(1006, ''), closed(1000), closed(4999, 'whatever'), closed(1011)], expected: { behaviour: 'RETRY' } },
  { id: 'stateless malformed-update; 4422', signals: [stateless({ kind: 'refusal', code: 'malformed-update' }), closed(4422)], expected: { behaviour: 'FRESH', log: 'web.collab_malformed' } },
  { id: 'stateless rate-limited', signals: [stateless({ kind: 'refusal', code: 'rate-limited' })], expected: { behaviour: 'NOTICE', text: 'You are sending changes faster than the server accepts.' } },
  { id: 'stateless presence-violation', signals: [stateless({ kind: 'refusal', code: 'presence-violation' })], expected: { behaviour: 'LOG', log: 'web.collab_presence' } },
  { id: 'stateless warning state-warning', signals: [stateless({ kind: 'warning', code: 'state-warning' })], expected: { behaviour: 'BANNER', text: 'This page is close to its size limit.' } },
  { id: 'client-too-old; 4426', signals: [refused('client-too-old'), closed(4426)], expected: { behaviour: 'RELOAD', text: 'A new version is available. Reload.' } },
  {
    id: 'stale-epoch; 4409',
    signals: [refused('stale-epoch'), closed(4409, 'stale-epoch'), closed(4409), stateless({ kind: 'refusal', code: 'stale-epoch' })],
    expected: { behaviour: 'FRESH', offerCopy: true, text: 'This page was reset. Your unsent changes were not applied.' },
  },
  {
    id: 'sign-in service unavailable',
    signals: [refused('Failed to get token during sendToken(): TokenUnavailable: no session token within 2000 ms')],
    expected: { behaviour: 'TOKEN', text: 'Sign-in is unavailable. Trying again.' },
  },
  { id: 'provider scope read-only after authentication', signals: [{ type: 'scope', readOnly: true }], expected: { behaviour: 'READ_ONLY', text: 'Read only' } },
];

/** The first cell of each row of the table in contracts section 6, as the contract writes it. */
const CONTRACT_ROWS = [
  'bad-document-name; 4400',
  'invalid-token; 4401, session-expired; 4401',
  'forbidden; 4403',
  'not-found; 4404',
  'page-full; 4413',
  'server-full; 4503',
  'documents-full; 4503',
  'memory-guard; 4503',
  'try-again; 4503',
  'state-corrupt; 4500',
  'internal-error; 4500',
  'seed-failed; 4501',
  'any unknown reason',
  'close reason access-changed; 4205',
  'close rate-limited; 4429',
  '1009 (raw message too big)',
  'stateless state-cap',
  'close 4408',
  'close 1001',
  '1006 and any close not listed',
  'stateless malformed-update; 4422',
  'stateless rate-limited',
  'stateless presence-violation',
  'stateless warning state-warning',
  'client-too-old; 4426',
  'stale-epoch; 4409',
  'sign-in service unavailable',
  'provider scope read-only after authentication',
] as const;

describe('mapSignal: every row of the table of contracts section 6', () => {
  it('has a test for every row of the table, and for no row that is not in it', () => {
    expect(ROWS.map((r) => r.id).sort()).toEqual([...CONTRACT_ROWS].sort());
  });

  for (const row of ROWS) {
    it(`${row.id}: ${row.expected.behaviour}, whichever way the signal arrives`, () => {
      row.signals.forEach((signal, i) => expect([i, mapSignal(signal)]).toEqual([i, expect.objectContaining(row.expected)]));
    });
  }

  it('chooses by the reason string, not by the code alone: a close the provider reports as 1000 still means what its reason says', () => {
    expect(mapSignal(closed(1000, 'access-changed')).behaviour).toBe('FRESH');
    expect(mapSignal(closed(1000, 'session-expired')).behaviour).toBe('REFRESH');
    expect(mapSignal(closed(1000, 'stale-epoch')).behaviour).toBe('FRESH');
    expect(mapSignal(closed(1000, 'stale-epoch')).offerCopy).toBe(true);
  });

  it('maps an unknown reason to ERROR and an unknown close code to RETRY', () => {
    expect(mapSignal(refused('never-heard-of-it')).behaviour).toBe('ERROR');
    expect(mapSignal(closed(4777)).behaviour).toBe('RETRY');
    expect(mapSignal(closed(0)).behaviour).toBe('RETRY');
  });

  it('retries a close 1006 without a reason, which is what an upgrade-time refusal looks like in a browser, no sooner than 2 s', () => {
    expect(mapSignal(closed(1006))).toMatchObject({ behaviour: 'RETRY', minDelayMs: 2000 });
    expect(mapSignal(closed(1006, 'with a reason')).minDelayMs).toBeUndefined();
  });

  it('reads the epoch message, and ignores anything that is not a message of this protocol', () => {
    expect(mapSignal(stateless({ kind: 'epoch', epoch: 4 }))).toEqual({ behaviour: 'EPOCH', epoch: 4 });
    for (const payload of [
      'not json',
      '[]',
      'null',
      '{"kind":"epoch","epoch":4}',
      '{"grimoire":2,"kind":"epoch","epoch":4}',
      '{"grimoire":1,"kind":"epoch","epoch":-1}',
      '{"grimoire":1,"kind":"epoch","epoch":1.5}',
      '{"grimoire":1,"kind":"epoch","epoch":"4"}',
      '{"grimoire":1,"kind":"warning","code":"other"}',
      '{"grimoire":1,"kind":"mystery"}',
    ])
      expect([payload, mapSignal({ type: 'stateless', payload }).behaviour]).toEqual([payload, 'IGNORE']);
  });

  it('logs, and does nothing else, for a refusal code it does not know; and ignores a scope that is read-write', () => {
    expect(mapSignal(stateless({ kind: 'refusal', code: 'brand-new' }))).toMatchObject({ behaviour: 'LOG' });
    expect(mapSignal({ type: 'scope', readOnly: false }).behaviour).toBe('IGNORE');
  });

  it('has the texts of the table in one place', () => {
    expect(TEXTS.rateLimited).toBe('You are sending changes faster than the server accepts. Trying again.');
    expect(TEXTS.offline).toBe('Offline: changes kept in this tab');
    expect(TEXTS.signInUnavailable).toBe('Sign-in is unavailable. Trying again.');
  });
});
