import { expectTypeOf } from 'vitest';
import { createApiClient } from '../src/index.js';
import type { paths } from '../src/index.js';

const client = createApiClient({ baseUrl: 'http://api.test' });

export async function typed(): Promise<void> {
  const ok = await client.GET('/v1/config');
  if (ok.data !== undefined) {
    expectTypeOf(ok.data.local).toEqualTypeOf<boolean>();
    expectTypeOf(ok.data.providerProjectId).toEqualTypeOf<string | null>();
    expectTypeOf(ok.data.fileStoreOrigin).toEqualTypeOf<string | null>();
  }
  // The error of a non-2xx result is typed with the envelope.
  if (ok.error !== undefined) expectTypeOf(ok.error.error.code).toEqualTypeOf<string>();

  // @ts-expect-error a path the document does not have
  await client.GET('/v1/nothing');
  // @ts-expect-error the config route has no POST
  await client.POST('/v1/config', {});
}

export type ConfigOperation = paths['/v1/config']['get'];
