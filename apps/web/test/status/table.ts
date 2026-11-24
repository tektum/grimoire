import type { Mapping, Signal } from '../../src/editor/core/map-signal';

/** What each row of the signal table (contracts section 6) that has a text must map to, written out by hand and independent of `map-signal.ts`. */
export interface Row {
  readonly id: string;
  readonly signals: readonly Signal[];
  readonly expected: Partial<Mapping>;
}

const refused = (reason: string): Signal => ({ type: 'authenticationFailed', reason });
const closed = (code: number, reason?: string): Signal => ({ type: 'close', code, ...(reason === undefined ? {} : { reason }) });
const stateless = (message: Record<string, unknown>): Signal => ({ type: 'stateless', payload: JSON.stringify({ grimoire: 1, ...message }) });

const BUSY = 'The server is busy. Trying again.';
const CANNOT = "This page can't be opened right now. Trying again.";

/** The id of each row is its test title's first part in `test-e2e/status/messages.spec.ts`. */
export const ROWS: readonly Row[] = [
  { id: 'bad-document-name; 4400', signals: [refused('bad-document-name'), closed(4400)], expected: { behaviour: 'ERROR', noRetry: true, text: 'Something went wrong opening this page. Reload.' } },
  { id: 'invalid-token; 4401, session-expired; 4401', signals: [refused('invalid-token'), closed(4401, 'session-expired'), closed(4401)], expected: { behaviour: 'REFRESH' } },
  { id: 'forbidden; 4403', signals: [refused('forbidden'), closed(4403)], expected: { behaviour: 'NO_ACCESS', text: 'You no longer have access to this page' } },
  { id: 'not-found; 4404', signals: [refused('not-found'), closed(4404)], expected: { behaviour: 'NOT_FOUND' } },
  { id: 'page-full; 4413', signals: [refused('page-full'), closed(4413)], expected: { behaviour: 'BUSY', minDelayMs: 10_000, text: 'This page already has 100 people editing. Try again in a moment.' } },
  ...['server-full', 'documents-full', 'memory-guard', 'try-again'].map((reason): Row => ({ id: `${reason}; 4503`, signals: [refused(reason), closed(4503)], expected: { behaviour: 'BUSY', minDelayMs: 10_000, text: BUSY } })),
  ...['state-corrupt', 'internal-error'].map((reason): Row => ({ id: `${reason}; 4500`, signals: [refused(reason), closed(4500)], expected: { behaviour: 'ERROR', text: CANNOT } })),
  { id: 'seed-failed; 4501', signals: [refused('seed-failed'), closed(4501)], expected: { behaviour: 'ERROR', noRetry: true, text: CANNOT } },
  { id: 'any unknown reason', signals: [refused('a-reason-no-client-has-seen')], expected: { behaviour: 'ERROR', text: CANNOT } },
  { id: 'close rate-limited; 4429', signals: [closed(1000, 'rate-limited'), closed(4429)], expected: { behaviour: 'BUSY', minDelayMs: 30_000, text: 'You are sending changes faster than the server accepts. Trying again.' } },
  { id: '1009 (raw message too big)', signals: [closed(1009)], expected: { behaviour: 'LARGE', text: 'This page is too large to edit further. You can still read it.' } },
  { id: 'stateless state-cap', signals: [stateless({ kind: 'refusal', code: 'state-cap' })], expected: { behaviour: 'LARGE', text: 'This page is too large to edit further. You can still read it.' } },
  { id: 'stateless warning state-warning', signals: [stateless({ kind: 'warning', code: 'state-warning' })], expected: { behaviour: 'BANNER', text: 'This page is close to its size limit.' } },
  { id: 'client-too-old; 4426', signals: [refused('client-too-old'), closed(4426)], expected: { behaviour: 'RELOAD', text: 'A new version is available. Reload.' } },
  { id: 'stale-epoch; 4409', signals: [refused('stale-epoch'), closed(4409), stateless({ kind: 'refusal', code: 'stale-epoch' })], expected: { behaviour: 'FRESH', offerCopy: true, text: 'This page was reset. Your unsent changes were not applied.' } },
  { id: 'sign-in service unavailable', signals: [refused('Failed to get token: the sign-in service is unavailable')], expected: { behaviour: 'TOKEN', text: 'Sign-in is unavailable. Trying again.' } },
  { id: 'provider scope read-only after authentication', signals: [{ type: 'scope', readOnly: true }], expected: { behaviour: 'READ_ONLY', text: 'Read only' } },
];

/** What is wrong with a `mapSignal`, row by row; empty when it maps every row of the table as it must. */
export function failures(map: (signal: Signal) => Mapping): string[] {
  const wrong: string[] = [];
  for (const row of ROWS) {
    row.signals.forEach((signal, i) => {
      const got = map(signal);
      for (const [key, value] of Object.entries(row.expected)) {
        if ((got as unknown as Record<string, unknown>)[key] !== value) wrong.push(`${row.id} [${i}]: ${key} is ${JSON.stringify((got as unknown as Record<string, unknown>)[key])}, not ${JSON.stringify(value)}`);
      }
    });
  }
  return wrong;
}
