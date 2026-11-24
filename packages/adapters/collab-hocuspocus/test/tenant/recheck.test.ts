import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERVAL_MS, PAGE, rig, SUBJECT } from '../recheck/support.js';
import type { Rig } from '../recheck/support.js';

// docs/tenancy.md, 3.4 (section 7, item 2): a connection that is open when its person's tenant changes (an administrator moves them, a migration does) is closed at the next
// re-check like any lost permission: 4205 access-changed, which the client answers by connecting again, and the new handshake then decides afresh.
const CLOSED = { code: 4205, reason: 'access-changed' };
const stops: Rig[] = [];
const started = (r: Rig): Rig => { stops.push(r); return r; };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const r of stops.splice(0)) r.recheck.stop(); vi.useRealTimers(); });

/** A rig whose person and page are both of tenant A. */
function inTenantA(): Rig {
  const r = started(rig());
  r.t.users.setTenant(SUBJECT, 'tenant-a');
  for (const page of r.t.world.pages) page.tenantId = 'tenant-a';
  return r;
}

describe('the re-check and the tenant', () => {
  it('leaves a person of the page\'s tenant connected, round after round', async () => {
    const r = inTenantA();
    const c = await r.open();
    await r.elapse(INTERVAL_MS * 3);
    expect(c.closes).toEqual([]);
  });

  it('closes the connection of a person who has been moved to another tenant, within one interval, 4205 access-changed, with the same log line as any lost access', async () => {
    const r = inTenantA();
    const c = await r.open();
    await r.elapse(INTERVAL_MS);
    expect(c.closes).toEqual([]);
    r.t.users.setTenant(SUBJECT, 'tenant-b');
    await r.elapse(INTERVAL_MS);
    expect(c.closes).toEqual([CLOSED]);
    expect(r.events('collab.access_closed')).toEqual([{ pageId: PAGE, reason: 'no-access' }]);
  });

  it('closes it when the page is the one that moved to another tenant', async () => {
    const r = inTenantA();
    const c = await r.open();
    for (const page of r.t.world.pages) page.tenantId = 'tenant-b';
    await r.elapse(INTERVAL_MS);
    expect(c.closes).toEqual([CLOSED]);
  });

  it('closes only the person who moved: another person of the same page and tenant stays', async () => {
    const r = inTenantA();
    const other = await r.t.idOf('u2');
    r.t.users.setTenant('u2', 'tenant-a');
    const mine = await r.open();
    const theirs = await r.open({ subject: 'u2', ...(other === undefined ? {} : { userId: other }), peerId: 'p2' });
    r.t.users.setTenant(SUBJECT, 'tenant-b');
    await r.elapse(INTERVAL_MS);
    expect(mine.closes).toEqual([CLOSED]);
    expect(theirs.closes).toEqual([]);
  });
});
