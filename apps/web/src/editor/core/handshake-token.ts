/** The longest handshake token the provider may send (contracts section 6): the prefix, and the base64url of the JSON around a session token. */
export const MAX_HANDSHAKE_LENGTH = 8192;
/** How long the token function may take to hand out a session token. The socket is open and unauthenticated while it waits, and the server closes such a socket after its own window (5 s by default). */
export const TOKEN_WAIT_MS = 2000;
const PREFIX = 'g1.';

/** The session token could not be had in time, or the token is too long to carry. The provider turns the rejection into an `authenticationFailed` with this text. */
export class TokenUnavailable extends Error {
  override readonly name = 'TokenUnavailable';
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realTimers: Timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface HandshakeTokenOptions {
  /** The session token (`auth.getToken()`): refreshed first when it is about to end. Null when signed out. */
  readonly getToken: () => Promise<string | null>;
  readonly clientVersion: string;
  /** The state epoch recorded for the page, or null before one was (a first connect sends none). */
  readonly epoch: () => number | null;
  readonly timers?: Timers;
  readonly waitMs?: number;
}

/**
 * The provider's `token` option: an async function the provider calls on every connect and every automatic reconnect, which returns the handshake token,
 * `g1.` and the base64url of `{"t": session token, "v": version, "e": epoch}` (`e` only once an epoch was recorded). It never waits longer than
 * `waitMs` for the session token: a longer wait would leave an unauthenticated socket open past the server's window, so it fails instead and the
 * manager tries again.
 */
export function createHandshakeToken(options: HandshakeTokenOptions): () => Promise<string> {
  const timers = options.timers ?? realTimers;
  const waitMs = options.waitMs ?? TOKEN_WAIT_MS;
  return async () => {
    let timer: unknown;
    const late = new Promise<never>((_, reject) => {
      timer = timers.setTimeout(() => reject(new TokenUnavailable(`no session token within ${waitMs} ms`)), waitMs);
    });
    let session: string | null;
    try {
      session = await Promise.race([options.getToken(), late]);
    } catch (error) {
      throw error instanceof TokenUnavailable ? error : new TokenUnavailable('the session token could not be read');
    } finally {
      timers.clearTimeout(timer);
    }
    if (session === null || session === '') throw new TokenUnavailable('signed out');
    const epoch = options.epoch();
    const claims: { t: string; v: string; e?: number } = { t: session, v: options.clientVersion };
    if (epoch !== null) claims.e = epoch;
    const token = `${PREFIX}${base64url(JSON.stringify(claims))}`;
    if (token.length > MAX_HANDSHAKE_LENGTH) throw new TokenUnavailable('the session token is too long for the handshake');
    return token;
  };
}
