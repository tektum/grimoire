import createClient from 'openapi-fetch';
// The generated declarations are imported as `../src/schema.js`: that names the same file from here and from `dist/index.d.ts`
// (the compiler does not copy a `.d.ts` into `dist`), so the types stay resolvable for whoever imports the built package.
import type { paths } from '../src/schema.js';

export type { paths, components } from '../src/schema.js';

export interface ApiClientOptions {
  /** Origin of the API, without a trailing slash. */
  readonly baseUrl: string;
  /** Called before every request; a token is sent as `Authorization: Bearer`, `null` or `undefined` sends none. */
  readonly getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Sent as `X-Grimoire-Client-Version`, which the server compares with its minimum. */
  readonly clientVersion?: string;
  /** Replaces the global `fetch` (tests pass one that calls the app in process). */
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** A client typed from the generated schema: paths, bodies, parameters, results and the error envelope all come from `openapi.json`. */
export function createApiClient(options: ApiClientOptions) {
  const client = createClient<paths>({ baseUrl: options.baseUrl, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  client.use({
    async onRequest({ request }) {
      const token = await options.getToken?.();
      if (token !== null && token !== undefined) request.headers.set('Authorization', `Bearer ${token}`);
      if (options.clientVersion !== undefined) request.headers.set('X-Grimoire-Client-Version', options.clientVersion);
      return request;
    },
  });
  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;
