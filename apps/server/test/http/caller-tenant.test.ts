import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { callerTenant } from '../../src/http/collection-guard.js';
import type { AppEnv } from '../../src/http/env.js';

const as = (tenantId: string | undefined) => ({ get: () => ({ id: 'u1', descopeUserId: 'd1', email: 'a@example.test', name: 'A', role: 'member', suspended: false, ...(tenantId === undefined ? {} : { tenantId }) }) }) as unknown as Context<AppEnv>;

describe('the tenant of the caller', () => {
  it('is the tenant of the stored row, and legacy for a row that names none', () => {
    expect(callerTenant(as('T-acme'))).toBe('T-acme');
    expect(callerTenant(as(undefined))).toBe('legacy');
  });
});
