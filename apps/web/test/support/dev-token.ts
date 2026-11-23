/** The development sign-in token: `dev:<secret>:<userId>:<role>` (the server accepts it only in local mode). */
export const DEV_TOKEN_PATTERN = /^dev:[A-Za-z0-9_-]{16,128}:[a-z0-9_-]{1,64}:(admin|member|viewer)$/;
export const DEV_TOKEN_MAX_LENGTH = 256;
export const DEV_ROLES = ['admin', 'member', 'viewer'] as const;
export type DevRole = (typeof DEV_ROLES)[number];

const SECRET_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const USER_ID_SHAPE = /^[a-z0-9_-]{1,64}$/;

/** A failure with a plain one-line message. No message ever holds the secret or a token. */
export class DevTokenError extends Error {
  override readonly name = 'DevTokenError';
}

/**
 * The secret the server was started with: `E2E_DEV_TOKEN_SECRET` when set, else `GRIMOIRE_DEV_TOKEN_SECRET` of the `.env` text
 * (`make dev-secret` writes it there). When there is none, the message names the variable to set.
 */
export function readDevSecret(env: Readonly<Record<string, string | undefined>>, envFileText?: string): string {
  const fromEnv = env['E2E_DEV_TOKEN_SECRET'];
  const fromFile = envFileText?.match(/^GRIMOIRE_DEV_TOKEN_SECRET=(.*)$/m)?.[1]?.trim();
  const secret = fromEnv !== undefined && fromEnv !== '' ? fromEnv : fromFile;
  if (secret === undefined || secret === '') throw new DevTokenError('No development token secret: set E2E_DEV_TOKEN_SECRET, or run `make dev-secret` so that .env has GRIMOIRE_DEV_TOKEN_SECRET.');
  if (!SECRET_SHAPE.test(secret)) throw new DevTokenError('The development token secret must be 16 to 128 characters of A-Z, a-z, 0-9, _ and -; check E2E_DEV_TOKEN_SECRET or .env.');
  return secret;
}

/** Builds the bearer token for a user. A user id must be lowercase: the server refuses an uppercase one. */
export function buildDevToken(secret: string, userId: string, role: DevRole): string {
  if (!USER_ID_SHAPE.test(userId)) throw new DevTokenError('A development user id is 1 to 64 lowercase letters, digits, - or _.');
  if (!DEV_ROLES.includes(role)) throw new DevTokenError('A development role is admin, member or viewer.');
  const token = `dev:${secret}:${userId}:${role}`;
  if (token.length > DEV_TOKEN_MAX_LENGTH) throw new DevTokenError(`A development token is at most ${DEV_TOKEN_MAX_LENGTH} characters; use a shorter user id or secret.`);
  return token;
}
