// The modules that may use the operator connection (`OperatorDatabase`, `createOpsDatabase` and `operator()` of @tektum/grimoire-adapter-db-kysely, or the setting `opsUrl`): the role
// grimoire_ops, which the row-level security of docs/tenancy.md section 3.2 lets see every tenant. Rule: each entry names one module, by its path from the root of the
// repository, and the reason it must cross tenants (a sign-in lookup by subject, a job or clean-up over every tenant, the audit append). Everything else takes the
// runtime database through `scoped(db, tenant)`. A new entry is a security decision: the pull request says so. `node tools/ci/check-operator-sites.mjs` (part of
// `bun run lint`) fails on any use outside this list.
/** @type {readonly { readonly module: string, readonly reason: string }[]} */
export const OPERATOR_SITES = [];
