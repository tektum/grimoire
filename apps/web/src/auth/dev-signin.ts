import type { ClientStorage } from '../storage';

// The development sign-in (local mode only): a form builds `dev:<secret>:<userId>:<role>`, the server is asked who that is, and the token is kept under
// the `ClientStorage` key `dev-token`. This module is imported dynamically behind `__GRIMOIRE_DEV_SIGNIN__`, so a production build holds none of it
// (the marker below is what `check:build` looks for). A development token cannot be refreshed: it lives one hour, then the client signs out.
export const DEV_SIGNIN_MARKER = 'grimoire-dev-signin';
export const DEV_TOKEN_KEY = 'dev-token';
export const DEV_TOKEN_EXPIRES_KEY = 'dev-token-expires';
export const DEV_TOKEN_LIFE_MS = 3_600_000;
export const DEV_ROLES = ['admin', 'member', 'viewer'] as const;
export type DevRole = (typeof DEV_ROLES)[number];

export const DEV_FORM_TEXTS = {
  userId: 'The user id is 1 to 64 lowercase letters, digits, - or _.',
  role: 'Choose admin, member or viewer.',
  secret: 'The secret is 16 to 128 letters, digits, - or _ (GRIMOIRE_DEV_TOKEN_SECRET of the .env file).',
  rejected: 'The server did not accept that user id and secret.',
  unreachable: "The server can't be reached.",
  notLocal: 'The server is not in local development mode.',
} as const;

const USER_ID = /^[a-z0-9_-]{1,64}$/;
const SECRET = /^[A-Za-z0-9_-]{16,128}$/;

export interface DevSignInInput {
  readonly userId: string;
  readonly role: string;
  readonly secret: string;
}
export type DevSignInResult = { readonly ok: true } | { readonly ok: false; readonly message: string };
export interface StoredDevToken {
  readonly token: string;
  readonly expiresAt: number;
}
export interface DevSignIn {
  /** The stored token and when it ends, or null when there is none. */
  read(): StoredDevToken | null;
  /** Removes what this sign-in stored. */
  clear(): void;
  signIn(input: DevSignInInput): Promise<DevSignInResult>;
}

/** The first problem with the form's values, as the text to show, or null. Nothing is sent before this passes, and no message holds the secret. */
export function validateDevForm(input: DevSignInInput): string | null {
  if (!USER_ID.test(input.userId)) return DEV_FORM_TEXTS.userId;
  if (!(DEV_ROLES as readonly string[]).includes(input.role)) return DEV_FORM_TEXTS.role;
  if (!SECRET.test(input.secret)) return DEV_FORM_TEXTS.secret;
  return null;
}

export interface DevSignInOptions {
  readonly apiUrl: string;
  readonly storage: ClientStorage;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
}

export function createDevSignIn(options: DevSignInOptions): DevSignIn {
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const { storage } = options;
  return {
    read() {
      const token = storage.get(DEV_TOKEN_KEY);
      const expiresAt = Number(storage.get(DEV_TOKEN_EXPIRES_KEY));
      return token !== null && Number.isFinite(expiresAt) && expiresAt > 0 ? { token, expiresAt } : null;
    },
    clear() {
      storage.remove(DEV_TOKEN_KEY);
      storage.remove(DEV_TOKEN_EXPIRES_KEY);
    },
    async signIn(input) {
      const problem = validateDevForm(input);
      if (problem !== null) return { ok: false, message: problem };
      const token = `dev:${input.secret}:${input.userId}:${input.role}`;
      let status: number;
      try {
        status = (await doFetch(`${options.apiUrl}/v1/me`, { credentials: 'omit', headers: { Authorization: `Bearer ${token}` } })).status;
      } catch {
        return { ok: false, message: DEV_FORM_TEXTS.unreachable };
      }
      if (status !== 200) return { ok: false, message: DEV_FORM_TEXTS.rejected };
      storage.set(DEV_TOKEN_KEY, token);
      storage.set(DEV_TOKEN_EXPIRES_KEY, String(now() + DEV_TOKEN_LIFE_MS));
      return { ok: true };
    },
  };
}
