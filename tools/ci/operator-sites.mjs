// The modules that may use the operator connection (`OperatorDatabase`, `createOpsDatabase` and `operator()` of @tektum/grimoire-adapter-db-kysely, or the setting `opsUrl`): the role
// grimoire_ops, which the row-level security of docs/tenancy.md section 3.2 lets see every tenant. Rule: each entry names one module, by its path from the root of the
// repository, and the reason it must cross tenants (a sign-in lookup by subject, a job or clean-up over every tenant, the audit append). Everything else takes the
// runtime database through `scoped(db, tenant)`. A new entry is a security decision: the pull request says so. `node tools/ci/check-operator-sites.mjs` (part of
// `bun run lint`) fails on any use outside this list.
/** @type {readonly { readonly module: string, readonly reason: string }[]} */
export const OPERATOR_SITES = [
  { module: 'apps/server/src/composition.ts', reason: 'builds the operator pools from GRIMOIRE_DATABASE_OPS_URL, one beside each runtime pool, and hands them to the adapters below' },
  { module: 'packages/adapters/db-kysely/src/users.ts', reason: 'sign-in finds a person by subject before any row gives a tenant (the tenant-mismatch refusal needs the row of any tenant), and a first sign-in checks the subject and the email across every tenant' },
  { module: 'packages/adapters/db-kysely/src/idempotency.ts', reason: 'the clean-up deletes the old keys of every tenant' },
  { module: 'packages/adapters/db-kysely/src/audit.ts', reason: 'an audit event that names no tenant takes its actor\'s tenant from the actor\'s row, in any tenant' },
  { module: 'packages/adapters/db-kysely/src/tenants.ts', reason: 'the jobs list every tenant, then do each tenant\'s work through scoped()' },
  { module: 'packages/adapters/db-kysely/src/revisions.ts', reason: 'the revision catch-up finds the due pages of every tenant' },
  { module: 'packages/adapters/db-kysely/src/page-store.ts', reason: 'the stale-Markdown sweep lists the stale pages of every tenant' },
];
