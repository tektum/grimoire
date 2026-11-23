import type { CollectionPatch, CollectionRecord, CollectionRepo, StoredPermission } from '@tektum/grimoire-core/ports/collection-repo';
import { insertAuditEvent } from './audit.js';
import type { KyselyDatabase } from './index.js';

interface Row { id: string; name: string; description: string | null; icon: string | null; color: string | null; position: string; default_permission: StoredPermission | null }

const COLUMNS = 'id, name, description, icon, color, position, default_permission';
const record = (r: Row): CollectionRecord => ({
  id: r.id, name: r.name, description: r.description, icon: r.icon, color: r.color, position: r.position, defaultPermission: r.default_permission,
});
/** Collection names the patch may set, with their columns (a fixed list: no request text ever reaches the statement). */
const PATCH_COLUMNS = [
  ['name', 'name'], ['description', 'description'], ['icon', 'icon'], ['color', 'color'], ['defaultPermission', 'default_permission'], ['position', 'position'],
] as const;

const isPositionTaken = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'code' in e && e.code === '23505' && 'constraint' in e && e.constraint === 'collections_position_uq';

/** The PostgreSQL CollectionRepo over `collections`. */
export function createCollections(db: KyselyDatabase): CollectionRepo {
  return {
    async listLive(ids) {
      if (ids.length === 0) return [];
      const rows = await db.query<Row>(`select ${COLUMNS} from collections where deleted_at is null and id = any($1::uuid[]) order by position`, [ids]);
      return rows.map(record);
    },
    async get(id) {
      const rows = await db.query<Row>(`select ${COLUMNS} from collections where id = $1 and deleted_at is null`, [id]);
      return rows[0] === undefined ? undefined : record(rows[0]);
    },
    append(input, positionAfter) {
      return db.transaction(async (tx) => {
        // Two creates at once must not pick the same position: one at a time, the last position read under the lock.
        await tx.query(`select pg_advisory_xact_lock(hashtext('grimoire.collections.position'))`);
        const last = (await tx.query<{ position: string }>(`select position from collections where deleted_at is null order by position desc limit 1`))[0];
        const rows = await tx.query<Row>(
          `insert into collections (name, description, icon, color, position, default_permission, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning ${COLUMNS}`,
          [input.name, input.description ?? null, input.icon ?? null, input.color ?? null, positionAfter(last?.position ?? null), input.defaultPermission ?? null, input.createdBy],
        );
        const created = record(rows[0] as Row);
        // A default permission set at creation grants access just as a later change does, so it leaves the same audit row.
        if (created.defaultPermission !== null) {
          await insertAuditEvent(tx, {
            actorId: input.createdBy, action: 'collection.default_permission_changed', targetType: 'collection', targetId: created.id,
            detail: { from: null, to: created.defaultPermission },
          });
        }
        return created;
      });
    },
    async update(id, patch: CollectionPatch, actorId) {
      try {
        return await db.transaction(async (tx) => {
          const before = (await tx.query<Row>(`select ${COLUMNS} from collections where id = $1 and deleted_at is null for update`, [id]))[0];
          if (before === undefined) return { kind: 'not-found' as const };
          const sets: string[] = [];
          const params: unknown[] = [id];
          for (const [key, column] of PATCH_COLUMNS) {
            const value = patch[key];
            if (value === undefined) continue;
            params.push(value);
            sets.push(`${column} = $${String(params.length)}`);
          }
          const rows = await tx.query<Row>(`update collections set ${[...sets, 'updated_at = now()'].join(', ')} where id = $1 returning ${COLUMNS}`, params);
          const after = record(rows[0] as Row);
          if (after.defaultPermission !== before.default_permission) {
            await insertAuditEvent(tx, {
              actorId, action: 'collection.default_permission_changed', targetType: 'collection', targetId: id,
              detail: { from: before.default_permission, to: after.defaultPermission },
            });
          }
          return { kind: 'updated' as const, collection: after };
        });
      } catch (e) {
        if (isPositionTaken(e)) return { kind: 'position-taken' };
        throw e;
      }
    },
  };
}
