import { randomUUID } from 'node:crypto';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import * as Y from 'yjs';
import { insertPage } from '@tektum/grimoire-test-support/database';
import { sqlAdmin } from '../server/support/harness.js';
import { eventually } from '@tektum/grimoire-test-support';
import type { Client } from '@tektum/grimoire-test-support';
import { appUrl } from '@tektum/grimoire-test-support/database';

export { eventually };

export const newPage = (): string => randomUUID();

/** The development collection (contracts section 4): default permission read_write, so every member may edit and a viewer may read. */
export const DEV_COLLECTION = '00000000-0000-4000-8000-0000000000d1';
const SYSTEM_USER = '00000000-0000-4000-8000-000000000001';

/** The test users and the "Dev" collection, through the real tables (idempotent). `descope_user_id` is the dev-token subject. */
export async function devFixtures(db: string): Promise<void> {
  // The editors of these tests are the two users of m2-support.ts: `last_edited_by` has a foreign key to users since 0004.
  await sqlAdmin(db, `insert into users (id, descope_user_id, email, name) values
    ('11111111-1111-4111-8111-111111111111', 'alice', 'alice@example.invalid', 'alice'), ('22222222-2222-4222-8222-222222222222', 'bob', 'bob@example.invalid', 'bob')
    on conflict do nothing`);
  await sqlAdmin(db, `insert into collections (id, name, position, default_permission, created_by) values ('${DEV_COLLECTION}', 'Dev', 'a0', 'read_write', '${SYSTEM_USER}') on conflict do nothing`);
}

/** A page in "Dev": since a page needs a collection the user can read (the earlier authorisation stub let anyone open any page). */
export async function seedPage(db: string, id: string): Promise<void> {
  await devFixtures(db);
  await insertPage((sql) => sqlAdmin(db, sql), { id, collection_id: DEV_COLLECTION });
}

export interface Row { ydoc: Uint8Array | null; ydoc_size: number | null; updated_at: string }

export async function pageRow(db: string, id: string): Promise<Row | undefined> {
  const rows = await sqlAdmin<Row>(db, `select ydoc, ydoc_size, updated_at::text from pages where id = '${id}'`);
  return rows[0];
}

export function textOf(state: Uint8Array | null | undefined, field = 'prosemirror'): string {
  const d = new Y.Doc();
  if (state) Y.applyUpdate(d, new Uint8Array(state));
  return d.getText(field).toString();
}

export type { Client };
/** The origin the harness server allows (`GRIMOIRE_ALLOWED_ORIGINS` in support/harness.ts). */
export { ALLOWED_ORIGIN } from '@tektum/grimoire-test-support';
/** Node's global WebSocket sends no Origin and the provider passes one argument; undici accepts headers in its init dictionary. */
export { originSocket } from '@tektum/grimoire-test-support';


export const synced = (c: Client): Promise<void> => eventually(() => (c.provider.synced ? true : undefined), 5000, 'provider synced').then(() => undefined);
export const wsUrl = (port: number): string => `ws://127.0.0.1:${String(port)}/collab`;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A TCP proxy to the Compose database that can stall: while stalled, bytes in both directions are held back, so queries neither return nor
 * fail, exactly what the server sees when the database host freezes (`docker pause`). It stands in for `docker pause` in the suite because
 * pausing the one shared container would freeze every other integration file running in parallel; the hand check with the real pause is in the report.
 */
export class StallProxy {
  private stalled = false;
  private lastTrafficAt = Date.now();
  private readonly held: (() => void)[] = [];
  private readonly sockets = new Set<net.Socket>();
  private readonly server: net.Server;
  port = 0;

  private constructor(private readonly target: { host: string; port: number }) {
    this.server = net.createServer((client) => {
      const upstream = net.connect(target.port, target.host);
      this.sockets.add(client).add(upstream);
      const forward = (from: net.Socket, to: net.Socket): void => {
        from.on('data', (chunk: Buffer) => {
          this.lastTrafficAt = Date.now();
          const send = (): void => { if (!to.destroyed) to.write(chunk); };
          if (this.stalled) this.held.push(send); else send();
        });
        from.on('close', () => { to.destroy(); this.sockets.delete(from); });
        from.on('error', () => { to.destroy(); });
      };
      forward(client, upstream);
      forward(upstream, client);
    });
  }

  static async start(target = { host: '127.0.0.1', port: 55432 }): Promise<StallProxy> {
    const p = new StallProxy(target);
    await new Promise<void>((resolve) => { p.server.listen(0, '127.0.0.1', resolve); });
    p.port = (p.server.address() as AddressInfo).port;
    return p;
  }

  /** Milliseconds since bytes last passed through in either direction. */
  quietForMs(): number { return Date.now() - this.lastTrafficAt; }
  stall(): void { this.stalled = true; }
  release(): void {
    this.stalled = false;
    for (const send of this.held.splice(0)) send();
  }
  async stop(): Promise<void> {
    this.release();
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => { this.server.close(() => { resolve(); }); });
  }
  url(db: string): string { return appUrl(db, `127.0.0.1:${String(this.port)}`); }
}

export { connect } from '@tektum/grimoire-test-support';
