import { describe, expect, it, vi } from 'vitest';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

const migrateAdapter = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ applied: string[]; jobTables: number }>>(async () => ({ applied: [], jobTables: 0 })));
vi.mock('../../src/composition.js', async (original) => ({ ...(await original<typeof import('../../src/composition.js')>()), migrateAdapter }));
const { composeMigrate } = await import('../../src/lifecycle/compose-migrate.js');

/** The queues are made by the migrate command, so the setting of the import expiry has to reach them from there. */
async function queuesFor(settings: Record<string, string>) {
  migrateAdapter.mockClear();
  const result = composeMigrate({ env: { GRIMOIRE_DATABASE_MIGRATION_URL: placeholderDatabaseUrl(), ...settings } });
  expect(result.ok).toBe(true);
  await result.migrate('migrations');
  const queues = migrateAdapter.mock.calls[0]?.[3] as readonly { name: string; expireInSeconds: number }[] | undefined;
  expect(queues, 'the queues the command gives the migration').toBeDefined();
  return queues ?? [];
}

describe('the migrate command and the queue of the imports', () => {
  it('gives the import queue the expiry the environment sets', async () => {
    expect((await queuesFor({ GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS: '20' })).find((q) => q.name === 'import')?.expireInSeconds).toBe(20);
  });

  it('gives it the default of 900 seconds when nothing is set', async () => {
    expect((await queuesFor({})).find((q) => q.name === 'import')?.expireInSeconds).toBe(900);
  });
});
