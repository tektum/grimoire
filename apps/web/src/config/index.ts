export interface WebConfig {
  readonly apiUrl: string;
  /** How long a hidden tab stays connected before the editor disconnects, in ms. */
  readonly hiddenDisconnectMs: number;
}

const DEFAULT_HIDDEN_MS = 600_000;

/** Reads `./config.json` (the only build-time setting: where the API is). Everything else comes from `GET /v1/config`. */
export async function loadWebConfig(fetchFn: typeof fetch = (input, init) => fetch(input, init)): Promise<WebConfig> {
  const response = await fetchFn('./config.json', { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`config.json: HTTP ${response.status}`);
  const raw: unknown = await response.json();
  if (typeof raw !== 'object' || raw === null) throw new Error('config.json: not an object');
  const { apiUrl, hiddenDisconnectMs } = raw as Record<string, unknown>;
  if (typeof apiUrl !== 'string' || apiUrl === '') throw new Error('config.json: apiUrl is missing');
  if (hiddenDisconnectMs !== undefined && (typeof hiddenDisconnectMs !== 'number' || !(hiddenDisconnectMs >= 0))) throw new Error('config.json: hiddenDisconnectMs must be a number of ms');
  return { apiUrl: apiUrl.replace(/\/+$/, ''), hiddenDisconnectMs: hiddenDisconnectMs ?? DEFAULT_HIDDEN_MS };
}
