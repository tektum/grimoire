# Tenancy: one workspace for each email domain

Status: proposal, for the owner's review. No code follows until it is accepted. Written after decision Q87 (option C: separate workspaces for each email domain, anyone can sign up).

It supersedes decision 2 ("100 to 1,000 people, one organisation") and changes the sign-in rules R8.1 to R8.9 of `docs/spec.md`. When it is accepted, those entries are updated in the same pull request that accepts it.

## 1. The model in one paragraph

A **tenant** is a workspace. There is one for each email domain that anyone has signed up with (`example.com`, not `mail.example.com`). The sign-in provider keeps the tenants: the sign-in flow creates the tenant for a person whose domain has none, names it after the domain, and lists the domain as the tenant's self-provisioning domain, so a later person with an address on that domain joins the same tenant by itself. The provider puts the person's tenant in the session token. The server trusts that claim, and nothing else, to decide which workspace a request belongs to. Everything the server stores belongs to one tenant, and no request can read or change another tenant's data.

## 2. Where the tenant comes from

### 2.1 The claim

Checked on a throwaway Descope project (since deleted), by signing two test users in through the flow of section 2.3 and reading the session token:

- **Without a JWT template** the token carries `tenants`, a map from tenant id to that person's roles (`{"T3...": {}}` for a person with no tenant roles), and no `dct`, no email and no name.
- **With a user JWT template** (`autoDCT` on, and the claims `email`, `name` and `emailVerified` set from `{{user.email}}`, `{{user.name}}` and `{{user.verifiedEmail}}`) the token carries `dct` (the current tenant id), `email`, `name`, `emailVerified` as a real boolean, and `tenants`. The names are the ones the server already reads.

So the template is made by code (`descope.JwtTemplate`, and its id given to the session settings as the user template) and the server's rule is:

- the tenant is `dct` when it is a string of a bounded length and a key of `tenants`; when `dct` is absent and `tenants` has exactly one key, that key; anything else is the "no tenant" case (section 6);
- a token with more than one key in `tenants` and no usable `dct` is refused in the first version (open question 5).

### 2.2 The token carries the profile too, so no runtime key is needed

Today the server reads email and name from claims when the token has them, and otherwise asks the provider's management API with a project key (the staging stack makes a read-only key for that). The same template carries `email`, `name` and `emailVerified` (checked, section 2.1), so the key and its secret can go: the staging stack drops them in the change that adds the template.

### 2.3 What the sign-in flow does

Checked end to end on the throwaway project with two test users of one domain. After the person has proved the address (`verify-code-otp-email`):

1. A condition on `user.tenantCount` (greater than 0): a person who has a tenant goes straight to the end.
2. Otherwise the action `update-user-tenant-email-domain` ("add a tenant to user according to the user's email domain; the email must be valid and verified") joins the person to the tenant whose self-provisioning domain is theirs. When there is none it answers `ActionErrorUpdateUserTenantByEmailDomainNoTenant`.
3. On that answer the action `createTenant` ("create a new tenant, and assign it to user") runs with the tenant name and the self-provisioning domain both `{{user.emailDomain}}`, and "set as selected tenant" on. If another sign-up made the tenant in the meantime it answers `TenantExists`, and the flow goes back to step 2.

Observed: the first person got a tenant named `spike.test` with `spike.test` as its self-provisioning domain; the second person of that domain joined the same tenant and no second tenant was made. The flow is kept as JSON in `infra/descope/flows/`.

The action `check-if-free-email` ("check if the provided email is a free email domain") exists in the flow catalog. Placing it before step 2 would refuse public mailbox providers inside the flow itself, which is one way to answer open question 1 (the other is a refused-domains list in the server's settings, section 3.7). It is not in the flow until the owner decides.

## 3. What is scoped, and how

The rule, for every table: a `tenant_id` column that is not null and references `tenants`, set from the token on every write, and a filter on it in every read. The server never takes a tenant id from a path, a query, a body or a header.

### 3.1 Tables

| Table | Change |
|---|---|
| `tenants` (new) | `id` (the provider's tenant id, text), `name`, `domain`, `created_at`. A row is made when the first person of a tenant signs in. |
| `users` | `tenant_id`. `descope_user_id` and `email` stay unique across the whole database (one person, one tenant). Roles (admin, member, viewer) are per tenant by construction. |
| `groups`, `group_members` | `tenant_id` on `groups`; the name is unique within a tenant (`unique (tenant_id, name)` replaces the global unique name). A member must be a user of the same tenant (a composite foreign key). |
| `collections` | `tenant_id`; `position` is unique within a tenant (the global partial unique index becomes `(tenant_id, position)`). |
| `collection_access` | The principal (user or group) and the collection are checked to be in the same tenant by composite foreign keys. |
| `pages` | `tenant_id` on the row too (not only through its collection), with a composite foreign key `(collection_id, tenant_id)`, so a page cannot sit in another tenant's collection and every page query can filter without a join. `url_id` stays globally unique (it is random). The search columns are filtered by the same column. |
| `revisions` | `tenant_id`, same composite key to the page. |
| `attachments` | `tenant_id`, same composite key to the page. |
| `audit_events` | `tenant_id`; an admin reads only their tenant's events. |
| `idempotency_keys` | The stored key is scoped by tenant as well as by user. |
| `imports`, `import_items` | `tenant_id`; the target collection must be in the same tenant. |
| job queue (pg-boss) | Every job payload carries the tenant id, and a handler loads its rows with it, so a payload cannot reach another tenant's row. |

### 3.2 Defence in depth: row-level security

The primary protection is the explicit scoping above, with tests (section 8). I propose a backstop under it: PostgreSQL row-level security on every tenant table for the runtime role (`grimoire_app`), policy `tenant_id = current_setting('app.tenant')`, with the setting made by `set_config(..., true)` at the start of every transaction. A query that forgets its filter then sees no rows instead of everyone's. The migrator role owns the tables and is not subject to the policies, so migrations and the operator's tools are unchanged. Cost: every request runs in a transaction that sets the tenant (the connection pool is shared, so the setting must be transaction-local), and a few jobs that cross tenants (clean-up of expired files) need an explicit operator mode. This is open question 3.

### 3.3 Routes

Every operation of `/v1` takes its tenant from the authenticated identity. An id that belongs to another tenant answers **404**, the same as an id that does not exist (never 403, which would say it exists). Lists contain only the tenant's rows. Concretely:

- `GET/POST /v1/collections`, `/v1/collections/{id}` (and `/tree`, `/access`): scoped; the access entries and groups named must be in the tenant.
- `GET/POST /v1/pages`, `/v1/pages/{id}` and `by-url-id`, `/move`, `/markdown`, `/reset-state`, `/revisions` (list, read, restore): scoped through the page row; `by-url-id` looks the slug up inside the tenant.
- `GET /v1/trash`, restore, purge: scoped.
- `GET /v1/users`, `PATCH /v1/users/{id}`, `POST /v1/users/names`: the tenant's people only; an administrator manages their tenant's roles and nobody else's.
- `GET/POST /v1/groups` and members: scoped.
- `POST /v1/attachments`, `/urls`, `/{id}/complete`, `GET /{id}`: the attachment row's tenant must equal the caller's before any signed link is made or any bucket call is sent.
- `GET /v1/me` and `/v1/config`: `/me` gains the tenant's id and name; `/config` is unchanged and carries nothing about any tenant.
- Search (planned): the query always carries the tenant filter, in the same statement as the text match; snippets and ranking are computed over the tenant's rows only.
- Imports (planned): the file, its items and the pages it creates are in the importing person's tenant.

### 3.4 Collaboration rooms

A room is named by its page id, and ids are random, so rooms of different tenants cannot collide. What must change is the admission: the authentication step loads the page, takes its tenant, and refuses the connection (as it refuses a missing page) when the person's tenant differs. The one-minute re-check applies the same test, so a person who changes tenant is closed out within a minute, like any lost permission. Connection counts and rate limits stay per user and per page; a per-tenant cap is open question 6. Log events gain the tenant id (never the domain).

### 3.5 File keys and signed links

Object keys today are `attachments/<id>`. New uploads use `tenants/<tenant id>/attachments/<id>`: an operator can see, size and delete one tenant's files by prefix, and a bug that confuses ids still cannot make a key outside the tenant's prefix. Rows keep the key they were stored with (`attachments.s3_key`), so old files need no copy. A signed link is made only after the row's tenant is checked. The bucket and its CORS rule stay shared.

### 3.6 Administrators and the first one

Today `GRIMOIRE_FIRST_ADMIN_EMAILS` makes named verified addresses administrators when they first sign in. With tenants:

- **Tenant administrators:** the person who creates a tenant (the first sign-up of a domain) becomes its administrator, and can promote others. That is the only way a new workspace gets an administrator without the operator.
- **The setting:** `GRIMOIRE_FIRST_ADMIN_EMAILS` stays, as the operator's way to make a named person an administrator of whatever tenant they sign into.
- **The operator:** there is no cross-tenant administrator in the application. Looking across tenants is a database task with the migrator role (open question 4).

### 3.7 Who may create a tenant

Anyone who can prove an address, which makes the domain the trust boundary. Two consequences, both decisions for the owner (open question 1): addresses at public mailbox providers must not become one shared workspace of strangers, and a domain nobody owns must not be claimable by whoever signs up first. My proposal is a list of refused domains in the settings (the public providers), and nothing more in the first version, because email delivery already proves the person controls an address on the domain.

## 4. The setting `GRIMOIRE_ALLOWED_EMAIL_DOMAINS`

Today it is the only gate, and empty means nobody (in non-local mode). Under tenancy:

- empty means any domain not on the refused list;
- non-empty remains an allow-list (a deployment that serves only some organisations, such as staging before tenancy is open);
- the refused list is a new setting, `GRIMOIRE_REFUSED_EMAIL_DOMAINS`.

Until tenancy lands, staging keeps the allow-list with one domain and no open sign-up.

## 5. Existing data (forward only)

No deployment holds data yet except development databases. The migration is forward only, like every other:

1. Make `tenants` and add `tenant_id` to every table as nullable, in one transaction.
2. Backfill every existing row with one tenant whose id is the fixed text `legacy`.
3. Make the columns not null, add the composite foreign keys and the per-tenant unique indexes (this replaces the global ones), and enable the policies (section 3.2) if accepted.
4. The command `grimoire tenant-adopt --from legacy --to <tenant id>` renames the legacy tenant to the provider's id of a real tenant, in one transaction, and refuses when the target has rows. It is the explicit step that moves a development workspace into a real tenant. Nothing runs it by itself.

New uploads use the new key prefix; old files keep their keys.

## 6. What the server does with each token

| Token | Result |
|---|---|
| valid, and a tenant by the rule of section 2.1 (`dct` in `tenants`, or the one key of `tenants`) | the person is that tenant's; the user row is made on first sight with that `tenant_id` (a `member`, or an administrator by section 3.6) |
| valid, no `tenants`, or `dct` not in `tenants`, or several keys and no `dct` | refused: `403` `no-tenant` on the API, a refusal at the collaboration handshake; a log line without personal data. The flow gives a new person a tenant before the token is made, so this is only a token from another flow or a person the provider has not yet assigned. |
| valid, the user row exists but belongs to another tenant than the claim | refused, and logged as a possible fault (the provider's claim and our row disagree). Not repaired by itself. |

## 7. Tests that must exist (written first, red first)

Two tenants A and B, each with an administrator, a member and a viewer, each with a collection, a page with a revision, a group, an attachment and a history. A test of isolation fails on the code of today (red first), then each change makes its part pass.

1. **API, by walking the routes.** For every operation of the registry (the policy walk already enumerates it), every id of B's data given by A answers 404 and changes nothing; every list of A contains none of B's rows; writes that name B's ids in the body (a group, a collection, a user, a parent page) are refused. A new route that has no entry fails the test (the walk is exhaustive, as the policy walk is).
2. **Collaboration.** A's token on B's page id is refused at the handshake, with the same refusal as a missing page; a connection open when A's person changes tenant is closed at the next re-check; awareness and presence of B's rooms are never sent to A.
3. **Files.** A cannot ask for a signed link, an upload or a completion for B's attachment id; a stored key outside the tenant's prefix is refused on read; a link made for A's file fetches only A's object.
4. **Search.** A's query never returns B's pages, titles or snippets, including for a word only B uses; the same query through the runtime role with no tenant set returns nothing (the backstop, if accepted).
5. **History and trash.** A cannot list, read or restore B's revisions, nor list, restore or purge B's trash.
6. **People and groups.** A's administrator cannot list, rename, suspend or change the role of B's users; group names may repeat across tenants; a member of B cannot be put in A's group.
7. **Audit and idempotency.** A's administrator sees only A's events; the same idempotency key from two tenants never replays across them.
8. **Jobs.** A job payload with a tenant id different from its row's is dropped and logged.
9. **Database.** With the runtime role and no tenant set, every tenant table returns no rows and refuses writes; a write with B's id while A's tenant is set is refused (if the policies are accepted). The migration test starts from the schema and data of today and ends with every row in the `legacy` tenant and every constraint in place.
10. **Sign-in.** A token without a usable tenant is refused on the API and at the handshake; a person's first sign-in makes their user row in the claim's tenant; a second person of the same tenant joins it and is not an administrator.

## 8. Small pull requests, in this order

1. This document, accepted, with the decision and spec entries it changes.
2. The sign-in flow and the JWT template in code (both checked on a throwaway project already; applied to the real projects only after the owner's go-ahead), with the token carrying tenant and profile, and the staging stack's runtime key removed.
3. The isolation tests, written first against today's code (red).
4. The migration: `tenants`, `tenant_id` everywhere, the legacy backfill, the composite keys, the per-tenant unique indexes.
5. The server reads the tenant from the verified token; every repository takes the tenant; the routes follow (several pull requests by area: pages and collections, people and groups, files, history and trash).
6. Collaboration admission and re-check by tenant; the key prefix of new uploads.
7. Row-level security, if accepted.
8. The settings (`GRIMOIRE_REFUSED_EMAIL_DOMAINS`, the meaning of the allow-list), `tenant-adopt`, the documentation and the staging switch to open sign-up.

## 9. Open questions for the owner

1. **Public mailbox domains and unowned domains.** Refuse a list of public providers (my proposal), refuse nothing, or require a stronger proof of the domain (a DNS record) before a tenant may use it? Without a decision the first person who signs up with an address at a public provider would create a workspace that every later person of that provider joins.
2. **Who is the first administrator of a new tenant?** The person who created it (my proposal), or nobody until the operator names one?
3. **Row-level security as a backstop:** yes (my proposal, with its cost in section 3.2) or only the explicit scoping and its tests?
4. **Is there an operator role inside the application** (a person who sees every tenant), or is cross-tenant work only a database task? My proposal is the database task: no such role in the first version.
5. **A person with more than one tenant** (a person who is later added to a second tenant by hand): refuse (my proposal for the first version), or let them choose, with the tenant picker of the provider?
6. **Per-tenant limits:** the connection and rate limits today are per user and per page. Do we want a cap on a whole tenant (people, storage, open pages) before open sign-up, so one tenant cannot use the service up?
7. **Existing development data:** is `legacy` and the explicit `tenant-adopt` command right, or should the first sign-in of an existing administrator adopt it automatically?
8. **Staging until tenancy lands:** keep sign-in closed to one domain (as decided), and open it only when steps 1 to 6 of section 8 are merged and the isolation tests pass.
