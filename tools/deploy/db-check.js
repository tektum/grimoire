// The read-only check of a stage's database (descope-infra.yml action=check, through tools/deploy/db-check.sh): it runs as `node -e` in the migration container of a
// one-off task, with the migration role's connection. That role owns the tables, so row-level security hides no row from it. It prints the server and extension versions,
// the row counts of pages and users, and, for every table with row-level security or a policy, whether it is enabled or forced and its policies with their roles.
// It reads only: a move to another database is checked by running it before the snapshot and after the deploy and comparing.
import('@tektum/grimoire-adapter-db-kysely').then(async ({ createDatabase }) => {
  const db = createDatabase(process.env.GRIMOIRE_DATABASE_MIGRATION_URL, { maxConnections: 1 });
  try {
    const [facts] = await db.query(`select current_setting('server_version') as server_version,
      (select string_agg(extname || '=' || extversion, ' ' order by extname) from pg_extension) as extensions,
      (select string_agg(version, ',' order by version) from pg_available_extension_versions where name = 'vector') as vector_available,
      (select count(*) from pages) as pages, (select count(*) from users) as users`);
    console.log(JSON.stringify(facts));
    const rows = await db.query(`select c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        coalesce(string_agg(p.polname || '>' || (select string_agg(rolname, '+' order by rolname) from pg_roles where oid = any(p.polroles)), ' ' order by p.polname), '-') as policies
      from pg_class c left join pg_policy p on p.polrelid = c.oid
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and (c.relrowsecurity or p.oid is not null)
      group by 1, 2, 3 order by 1`);
    for (const r of rows) console.log(JSON.stringify(r));
    console.log(JSON.stringify({ rls_tables: rows.filter((r) => r.rls).length, with_policies: rows.filter((r) => r.policies !== '-').length }));
  } finally {
    await db.close();
  }
}).catch((e) => { console.error(e.message); process.exit(1); });
