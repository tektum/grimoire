/** When a JWT expires, in ms since the epoch, from its `exp` claim; null when the text is not a readable token. The signature is not checked: the server does that. */
export function jwtExpiresAt(token: string): number | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const json = atob(
      payload
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(payload.length / 4) * 4, '='),
    );
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}
