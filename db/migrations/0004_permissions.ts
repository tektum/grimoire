import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// M3-T03 (contracts section 5): users, groups, collections and their access rows, and the permission columns of `pages`.
// Raw SQL, as in 0001 to 0003: the schema builder has no citext, `collate "C"`, partial unique indexes or deferrable composite foreign keys.
// Access is enforced in the server (decision 128): no row-level security here; the runtime role's privileges below are the backstop.
// `citext` is created by db/init/02-extensions.sql on a fresh local volume; this statement is then a no-op. On a managed service the extension must exist
// before the first run (or the migrating role must be allowed to create it): a trusted extension needs CREATE on the database.
const SYSTEM_USER = '00000000-0000-4000-8000-000000000001';
const UNFILED = '00000000-0000-4000-8000-000000000002';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create extension if not exists citext`.execute(db);

  // 10 base-62 characters from random bytes of gen_random_uuid() (bytes 6 and 8 carry the version and variant bits, so they are skipped);
  // bytes of 248 or more are dropped so that every character is equally likely.
  await sql`
    create function grimoire_url_id() returns text
      language plpgsql volatile set search_path = pg_catalog
      as $$
      declare
        alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        result text := '';
        bytes bytea;
        k int;
        v int;
      begin
        while length(result) < 10 loop
          bytes := uuid_send(gen_random_uuid());
          foreach k in array array[0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14, 15] loop
            v := get_byte(bytes, k);
            if v < 248 and length(result) < 10 then
              result := result || substr(alphabet, (v % 62) + 1, 1);
            end if;
          end loop;
        end loop;
        return result;
      end $$`.execute(db);
  await sql`revoke execute on function grimoire_url_id() from public`.execute(db);
  await sql`grant execute on function grimoire_url_id() to grimoire_app`.execute(db);

  await sql`
    create table users (
      id uuid primary key default gen_random_uuid(),
      descope_user_id text not null unique,
      email citext not null unique,
      name text not null,
      avatar_url text,
      role text not null default 'member' check (role in ('admin', 'member', 'viewer')),
      suspended_at timestamptz,
      last_seen_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`.execute(db);
  await sql`
    create table groups (
      id uuid primary key default gen_random_uuid(),
      name citext not null unique,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`.execute(db);
  await sql`
    create table group_members (
      group_id uuid not null references groups (id) on delete cascade,
      user_id uuid not null references users (id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (group_id, user_id)
    )`.execute(db);
  await sql`create index group_members_user_id_idx on group_members (user_id)`.execute(db);
  await sql`
    create table collections (
      id uuid primary key default gen_random_uuid(),
      name text not null check (char_length(name) between 1 and 100),
      description text,
      icon text,
      color text,
      position text collate "C" not null,
      default_permission text check (default_permission in ('read', 'read_write')),
      created_by uuid not null references users (id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )`.execute(db);
  await sql`
    create table collection_access (
      id uuid primary key default gen_random_uuid(),
      collection_id uuid not null references collections (id) on delete cascade,
      user_id uuid references users (id) on delete cascade,
      group_id uuid references groups (id) on delete cascade,
      permission text not null check (permission in ('read', 'read_write')),
      created_at timestamptz not null default now(),
      check ((user_id is null) <> (group_id is null))
    )`.execute(db);
  await sql`create unique index collection_access_user_uq on collection_access (collection_id, user_id) where user_id is not null`.execute(db);
  await sql`create unique index collection_access_group_uq on collection_access (collection_id, group_id) where group_id is not null`.execute(db);

  // The two rows existing pages and bare test inserts point at through the column defaults below. Only admins reach "Unfiled" (no default permission, no entries).
  await sql`
    insert into users (id, descope_user_id, email, name, role, suspended_at)
      values (${SYSTEM_USER}, 'system:migration', 'system@grimoire.invalid', 'System', 'viewer', now())`.execute(db);
  await sql`
    insert into collections (id, name, position, created_by)
      values (${UNFILED}, 'Unfiled', 'a0', ${SYSTEM_USER})`.execute(db);

  // `last_edited_by` has held no foreign key until now: values written before the users table existed cannot be checked, so they are dropped.
  // Hashes change definition (SHA-256 of title, NUL, Markdown): old ones are not backfilled, the next save of each page writes the new one.
  await sql`update pages set last_edited_by = null, markdown_hash = null`.execute(db);
  await sql`
    alter table pages
      add column url_id text not null default grimoire_url_id() unique,
      add column collection_id uuid not null default ${sql.lit(UNFILED)} references collections (id),
      add column parent_id uuid,
      add column position text collate "C" not null default 'a0',
      add column title text not null default '' check (char_length(title) <= 255),
      add column icon text,
      add column created_by uuid not null default ${sql.lit(SYSTEM_USER)} references users (id),
      add column deleted_at timestamptz,
      add column deleted_by uuid references users (id),
      add column deleted_batch uuid,
      add constraint pages_id_collection_uq unique (id, collection_id),
      add constraint pages_last_edited_by_fk foreign key (last_edited_by) references users (id)`.execute(db);
  // A page and its parent share a collection [R5.5]. Deferred, so that moving a subtree is one statement.
  await sql`
    alter table pages
      add constraint pages_parent_same_collection_fk foreign key (parent_id, collection_id)
        references pages (id, collection_id) deferrable initially deferred`.execute(db);

  // Explicit least-privilege grants, as in 0001: no TRUNCATE, REFERENCES or TRIGGER; nothing on kysely_migration*.
  await sql`grant select, insert, update, delete on users, groups, group_members, collections, collection_access, pages to grimoire_app`.execute(db);
}
