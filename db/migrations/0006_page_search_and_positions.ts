import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// Text search columns of `pages`, the page and collection indexes, and unique sibling positions. Raw SQL, as in 0001 to 0005.
// Forward-only: 0005 is merged and never edited, so what it did not hold lives here.
// The `tsv` rewrite of existing rows is accepted at fixture size (nothing is deployed before milestone 8).
export async function up(db: Kysely<unknown>): Promise<void> {
  // The `tsv` of a page: title weight A, the whole Markdown text weight B. A tsvector is limited to 1,048,575 bytes, so when the whole body
  // raises `program_limit_exceeded` the function retries with shorter prefixes and finally with the title alone; every attempt but the first
  // sets `search_partial`, so no page ever fails to save for its size. Runs as the caller; `pg_catalog` only on the search path.
  await sql`
    alter table pages
      add column tsv tsvector not null default '',
      add column search_partial boolean not null default false`.execute(db);
  await sql`
    create function pages_tsv_update() returns trigger
      language plpgsql set search_path = pg_catalog
      as $$
      declare
        body constant text := coalesce(new.text_content, '');
        title_part constant tsvector := setweight(to_tsvector('simple'::regconfig, new.title), 'A');
        prefix_length int;
      begin
        begin
          new.tsv := title_part || setweight(to_tsvector('simple'::regconfig, body), 'B');
          new.search_partial := false;
          return new;
        exception when program_limit_exceeded then
          new.search_partial := true;
        end;
        foreach prefix_length in array array[600000, 300000, 150000, 70000, 30000, 10000] loop
          begin
            new.tsv := title_part || setweight(to_tsvector('simple'::regconfig, left(body, prefix_length)), 'B');
            return new;
          exception when program_limit_exceeded then
            null;
          end;
        end loop;
        new.tsv := title_part;
        return new;
      end $$`.execute(db);
  await sql`
    create trigger pages_tsv_trg before insert or update of title, text_content on pages
      for each row execute function pages_tsv_update()`.execute(db);
  await sql`update pages set text_content = text_content`.execute(db);

  // Positions are renumbered before the unique indexes exist: rank over (position, created_at, id) among siblings (an existing order survives; only equal positions fall back to creation order), valid under `fractional-indexing`.
  await sql`
    update pages p set position = 'a0' || lpad(r.rank::text, 6, '0') || '1'
      from (select id, row_number() over (partition by collection_id, coalesce(parent_id, collection_id) order by position, created_at, id) as rank from pages) r
      where p.id = r.id`.execute(db);
  await sql`
    update collections c set position = 'a0' || lpad(r.rank::text, 6, '0') || '1'
      from (select id, row_number() over (order by position, created_at, id) as rank from collections) r
      where c.id = r.id`.execute(db);

  // The updates above queue the deferred parent foreign-key checks of 0004; PostgreSQL refuses ALTER TABLE and CREATE INDEX on `pages` while events are pending.
  await sql`set constraints all immediate`.execute(db);

  // Bare inserts (fixtures) stay unique: seven digits, so a default never equals a renumbered six-digit position. The API always passes a position.
  await sql`create sequence pages_position_seq`.execute(db);
  await sql`
    alter table pages alter column position
      set default 'a0' || lpad(nextval('pages_position_seq')::text, 7, '0') || '1'`.execute(db);

  await sql`
    create unique index pages_sibling_position_uq on pages (collection_id, coalesce(parent_id, collection_id), position)
      where deleted_at is null`.execute(db);
  await sql`create unique index collections_position_uq on collections (position) where deleted_at is null`.execute(db);
  await sql`create index pages_tree_idx on pages (collection_id, parent_id, position) where deleted_at is null`.execute(db);
  await sql`create index pages_tsv_idx on pages using gin (tsv) where deleted_at is null`.execute(db);
  await sql`create index pages_deleted_at_idx on pages (deleted_at) where deleted_at is not null`.execute(db);
  await sql`create index pages_parent_id_idx on pages (parent_id)`.execute(db);
  await sql`create index pages_deleted_batch_idx on pages (deleted_batch) where deleted_batch is not null`.execute(db);
  // pg_trgm comes from db/init/02-extensions.sql; without it the title index is skipped and a later migration can add it.
  await sql`
    do $$ begin
      if exists (select 1 from pg_extension where extname = 'pg_trgm') then
        create index pages_title_trgm_idx on pages using gin (title gin_trgm_ops);
      end if;
    end $$`.execute(db);

  // `set constraints` lasts until the transaction ends, and the migrator may run later migrations in it: restore the mode 0004 declared.
  await sql`set constraints pages_parent_same_collection_fk deferred`.execute(db);

  await sql`grant usage, select on sequence pages_position_seq to grimoire_app`.execute(db);
}
