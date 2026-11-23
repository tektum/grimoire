// Helpers of the milestone 4 end-to-end test (`make test-m4`). They extend the collaboration harness (../support.ts: scenario runner, peers, development tokens,
// the Compose helpers): the app runs in local mode, the three people of the development data sign in with development tokens, and every HTTP request goes
// through the generated client of packages/api-client, never a hand-written fetch.
import { randomUUID } from 'node:crypto';
import { createApiClient } from '@tektum/grimoire-api-client';
import { BASE, devToken, eventually, scenario } from '../support.ts';
import type { T } from '../support.ts';

// The collaboration runner writes to test-results/m1 unless told otherwise: these scenarios write to test-results/m4.
process.env['E2E_RESULTS_DIR'] ??= 'test-results/m4';

export { BASE, eventually, scenario };
export type { T };

/** The people of the development data (alice administrator, bob member, carol viewer) and their roles. */
export const PEOPLE = { alice: 'admin', bob: 'member', carol: 'viewer' } as const;
export type Person = keyof typeof PEOPLE;

/** A client signed in as `person`; `anonymous` sends no token. */
export const apiAs = (person: Person) => createApiClient({ baseUrl: BASE, getToken: () => devToken(person, PEOPLE[person]) });
export const anonymous = () => createApiClient({ baseUrl: BASE });
/** A client that sends exactly this token, whatever it is. */
export const apiWithToken = (token: string) => createApiClient({ baseUrl: BASE, getToken: () => token });

/** The part of an `openapi-fetch` answer these helpers read. */
interface Answer<D> { readonly data?: D; readonly error?: unknown; readonly response: Response }

/** The body of an answer that must have `status`; anything else is a failure naming what was attempted and what the server said. */
export function expectStatus<D>(answer: Answer<D>, status: number, what: string): D {
  if (answer.response.status !== status) {
    throw new Error(`${what}: expected ${String(status)}, got ${String(answer.response.status)} ${JSON.stringify(answer.error ?? answer.data ?? null)}`);
  }
  return answer.data as D;
}

/** The error code of the server's envelope in an answer, or undefined. */
export const errorCode = (answer: { readonly error?: unknown }): string | undefined => (answer.error as { error?: { code?: string } } | undefined)?.error?.code;

/** A name that no earlier run used. */
export const unique = (prefix: string): string => `${prefix} ${randomUUID().slice(0, 8)}`;

/** The user ids the server gave the three people, read from `GET /v1/me` (the first call of a person provisions the row). */
export async function signInAll(): Promise<Record<Person, string>> {
  const out = {} as Record<Person, string>;
  for (const person of Object.keys(PEOPLE) as Person[]) {
    const me = expectStatus(await apiAs(person).GET('/v1/me'), 200, `${person} signs in`);
    if (me.role !== PEOPLE[person]) throw new Error(`${person} has the role ${me.role}, expected ${PEOPLE[person]}`);
    out[person] = me.id;
  }
  return out;
}
