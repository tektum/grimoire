import { describe, it } from 'vitest';
import { FakeUserStore } from '../../src/testing/fake-user-store.js';
import { userStoreCapCases } from '../../src/testing/user-store-cap-conformance.js';

describe('FakeUserStore: the order in which a new person is judged', () => {
  it.each(userStoreCapCases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    await c.run({ store: new FakeUserStore([], 2), tenant: 'T-order' });
  });
});
