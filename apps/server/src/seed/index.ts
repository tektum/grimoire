import type { Database } from '@tektum/grimoire-core/ports/database';
import { ALICE, BOB, BOB_PRIVATE_ACCESS, DEV, PRIVATE, SEED_COLLECTIONS, SEED_PAGES, SEED_USERS } from './data.js';

/**
 * Inserts the development rows (`grimoire seed`, local mode only: the caller checks). Idempotent: every insert is `on conflict do nothing`,
 * so a second run, or a run on a database where someone edited a seeded row, changes nothing. Runs as the runtime role, in one transaction scoped to
 * the `legacy` tenant its rows take (the caller passes `scoped(db, 'legacy')`). `ydoc` stays null: the first editor to open a seeded page builds its
 * state from the Markdown.
 */
export async function seedLocal(db: Pick<Database, 'transaction'>): Promise<void> {
  await db.transaction(async (tx) => {
    // A developer who signed in locally before seeding already has a row for the same subject and email (a generated id): the seed builds on that row
    // instead of failing on its unique constraints, so the ids used below are the ones the database has.
    const actual = new Map<string, string>();
    for (const u of SEED_USERS) {
      await tx.query(
        'insert into users (id, descope_user_id, email, name, role) values ($1, $2, $3, $2, $4) on conflict do nothing',
        [u.id, u.name, `${u.name}@dev.invalid`, u.role],
      );
      const found = await tx.query<{ id: string }>('select id from users where descope_user_id = $1', [u.name]);
      actual.set(u.id, found[0]?.id ?? u.id);
    }
    const alice = actual.get(ALICE) ?? ALICE;
    const bob = actual.get(BOB) ?? BOB;
    for (const c of SEED_COLLECTIONS) {
      await tx.query(
        'insert into collections (id, name, position, default_permission, created_by) values ($1, $2, $3, $4, $5) on conflict (id) do nothing',
        [c.id, c.name, c.position, c.defaultPermission, alice],
      );
    }
    await tx.query(
      "insert into collection_access (id, collection_id, user_id, permission) values ($1, $2, $3, 'read_write') on conflict (id) do nothing",
      [BOB_PRIVATE_ACCESS, PRIVATE, bob],
    );
    for (const p of SEED_PAGES) await insertMarkdownOnlyPageUnsafeForUserText(tx, p, alice); // parents come first; the parent foreign key is deferred anyway
  });
}

/**
 * Inserts a page row that has Markdown and NO state. The collaboration host rebuilds such a row with `reseed`, which trusts Markdown our own
 * serialiser wrote (lenient limits). So this is for fixed, reviewed Markdown only (the dev seed data): NEVER for Markdown a person or an importer supplied,
 * which must go through `seed` and be stored as state (spec R7.13). The name is greppable on purpose.
 */
export async function insertMarkdownOnlyPageUnsafeForUserText(tx: { query: (sql: string, params: unknown[]) => Promise<unknown> }, p: (typeof SEED_PAGES)[number], createdBy: string = ALICE): Promise<void> {
  await tx.query(
    'insert into pages (id, collection_id, parent_id, position, title, markdown, text_content, created_by) values ($1, $2, $3, $4, $5, $6, $6, $7) on conflict (id) do nothing',
    [p.id, DEV, p.parentId, p.position, p.title, p.markdown, createdBy],
  );
}
