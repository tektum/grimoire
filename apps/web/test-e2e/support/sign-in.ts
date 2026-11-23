import type { BrowserContext } from '@playwright/test';
import { buildDevToken, DevTokenError, type DevRole } from '../../test/support/dev-token';
import { apiUrl, devSecret } from './env';

/** `ClientStorage` key `dev-token` (prefix `grimoire.`): where the web client keeps the development token. */
export const DEV_TOKEN_STORAGE_KEY = 'grimoire.dev-token';

export interface SignedInUser {
  readonly userId: string;
  readonly role: DevRole;
}

/**
 * Signs `context` in as a development user: every page of the context starts with the token in storage, as after the sign-in form,
 * and the token is checked against the server (`GET /v1/me` must answer 200), so a stopped server or a wrong secret fails here with one line.
 * The token is never printed or logged, and the check below uses Node's `fetch`, which a trace does not record. The storage write is recorded by a trace, so
 * `playwright.config.ts` keeps no traces in CI, and a local trace holds the token of a stack that accepts it in local mode only.
 */
export async function signInAs(context: BrowserContext, userId: string, role: DevRole = 'member', options: { check?: boolean } = {}): Promise<SignedInUser> {
  const token = buildDevToken(devSecret(), userId, role);
  if (options.check !== false) {
    let status: number;
    try {
      status = (await fetch(`${apiUrl()}/v1/me`, { headers: { Authorization: `Bearer ${token}` } })).status;
    } catch {
      throw new DevTokenError(`The API at ${apiUrl()} cannot be reached: start the stack (make up) or set E2E_API_URL.`);
    }
    if (status !== 200) throw new DevTokenError(`GET /v1/me answered ${status} for the development user: the stack must run in local mode (GRIMOIRE_LOCAL=1) with the same GRIMOIRE_DEV_TOKEN_SECRET.`);
  }
  await context.addInitScript(([key, value]) => window.localStorage.setItem(key as string, value as string), [DEV_TOKEN_STORAGE_KEY, token]);
  return { userId, role };
}
