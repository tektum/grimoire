# Tenancy: one workspace for each email domain

Status: proposal. The questions of section 9 are answered (the answers are recorded there as decided; the owner may still override them) and implementation follows in the order of section 8. Written after decision Q87 (option C: separate workspaces for each email domain, anyone can sign up).

It supersedes decision 2 ("100 to 1,000 people, one organisation") and changes the sign-in rules R8.1 to R8.9 of `docs/spec.md`. When it is accepted, those entries are updated in the same pull request that accepts it.

## 1. The model in one paragraph

A **tenant** is a workspace. There is one for each email domain that anyone has signed up with, taken as everything after the `@`: `a@example.com` and `b@mail.example.com` are in two tenants. (Reducing an address to its registrable domain needs the public suffix list and a rule for who owns a subdomain; it is a later option, open question 9.) The sign-in provider keeps the tenants: the sign-in flow creates the tenant for a person whose domain has none, names it after the domain, and lists the domain as the tenant's self-provisioning domain, so a later person with an address on that domain joins the same tenant by itself. The provider puts the person's tenant in the session token. The server trusts that claim, and nothing else, to decide which workspace a request belongs to. Everything the server stores belongs to one tenant, and no request can read or change another tenant's data.

## 2. Where the tenant comes from

### 2.1 The claim

Checked on a throwaway Descope project (since deleted), by signing two test users in through the flow of section 2.3 and reading the session token:

- **Without a JWT template** the token carries `tenants`, a map from tenant id to that person's roles (`{"T3...": {}}` for a person with no tenant roles), and no `dct`, no email and no name.
- **With a user JWT template** (`autoDCT` on, and the claims `email`, `name` and `emailVerified` set from `{{user.email}}`, `{{user.name}}` and `{{user.verifiedEmail}}`) the token carries `dct` (the current tenant id), `email`, `name`, `emailVerified` as a real boolean, and `tenants`. The names are the ones the server already reads.

So the template is made by code (`descope.JwtTemplate`, and its id given to the session settings as the user template) and the server's rule is:

- a token whose `tenants` has more than one key is refused, whatever `dct` says (decided: question 5, one tenant for each person in the first version; a person added by hand to a second tenant must not gain silent access);
- otherwise the tenant is `dct` when it is a string of a bounded length and a key of `tenants`, or, when `dct` is absent, the one key of `tenants`;
- anything else is the "no tenant" case (section 6).

### 2.2 The token carries the profile too, so no runtime key is needed

Today the server reads email and name from claims when the token has them, and otherwise asks the provider's management API with a project key (the staging stack makes a read-only key for that). The same template carries `email`, `name` and `emailVerified` (checked, section 2.1), so the key and its secret can go: the staging stack drops them in the change that adds the template. A token issued before the template existed carries no profile, and without the key a first sign-in with such a token is refused (`profile-missing`) until it is refreshed (ten minutes). That cannot happen here: each project is made by the stack with the template in the same deployment, so no token exists before it. A project that had tokens before gaining the template would keep the key for one maximum token lifetime.

### 2.3 What the sign-in flow does

Checked end to end on the throwaway project with two test users of one domain. After the person has proved the address (`verify-code-otp-email`):

1. A condition on `user.tenantCount` (greater than 0): a person who has a tenant goes straight to the end.
2. Otherwise the action `update-user-tenant-email-domain` ("add a tenant to user according to the user's email domain; the email must be valid and verified") joins the person to the tenant whose self-provisioning domain is theirs. When there is none it answers `ActionErrorUpdateUserTenantByEmailDomainNoTenant`.
3. On that answer the action `createTenant` ("create a new tenant, and assign it to user") runs with the tenant name and the self-provisioning domain both `{{user.emailDomain}}`, and "set as selected tenant" on. If another sign-up made the tenant in the meantime it answers `TenantExists`, and the flow goes back to step 2.

Observed: the first person got a tenant named `spike.test` with `spike.test` as its self-provisioning domain; the second person of that domain joined the same tenant and no second tenant was made. The flow is kept as JSON in `infra/descope/flows/`.

The action `check-if-free-email` ("check if the provided email is a free email domain") exists in the flow catalog. Placing it before step 2 would refuse public mailbox providers inside the flow itself, which is one way to refuse them (decided: the refusal is the server's, with a list and a setting, section 3.7; the flow action is not used) 

### 2.4 Local mode (development tokens)

The development verifier (`auth-dev`, local mode only) accepts `dev:<secret>:<user id>:<role>` and has no provider behind it, so it has no `tenants`. Left alone, every local request and collaboration handshake, and every integration test, would be refused as "no tenant". The token gains an optional fifth part: `dev:<secret>:<user id>:<role>[:<tenant id>]`, the tenant id being 1 to 64 characters of `[a-z0-9_-]`, and the verifier answers it exactly as the provider's claim is read (one tenant, no more). When the part is absent the tenant is the fixed local tenant `local`, so `make up`, the existing tests and every token already written keep working unchanged. The isolation suite of section 7 makes tokens for tenants A and B with the part. The part exists only in local mode (the adapter refuses to start outside it), so it is no way into a deployed tenant.

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

The primary protection is the explicit scoping above, with tests (section 7). Decided: a backstop under it: PostgreSQL row-level security on every tenant table for the runtime role (`grimoire_app`), policy `tenant_id = nullif(current_setting('app.tenant', true), '')` for reads and the same expression as `with check` for writes, with the setting made by `set_config(..., true)` at the start of every transaction. The second argument and the `nullif` matter: on a connection that never set the value the call returns null instead of failing, and on a pooled connection where an earlier transaction set it the value is the empty string, which becomes null, and a null (or an empty string) never equals a real `tenant_id`, so a query with no tenant set sees no rows and writes nothing, on a fresh connection and a reused one alike. A query that forgets its filter then sees no rows instead of everyone's. The migrator role owns the tables and is not subject to the policies, so migrations and the operator's tools are unchanged. Cost: every request runs in a transaction that sets the tenant (the connection pool is shared, so the setting must be transaction-local), and a few jobs that cross tenants (clean-up of expired files) need an explicit operator mode. (Question 3: decided, yes.)

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

A room is named by its page id, and ids are random, so rooms of different tenants cannot collide. What must change is the admission: the authentication step loads the page, takes its tenant, and refuses the connection (as it refuses a missing page) when the person's tenant differs. The one-minute re-check applies the same test, so a person who changes tenant is closed out within a minute, like any lost permission. Connection counts and rate limits stay per user and per page; the caps of a whole tenant are section 3.8. Log events gain the tenant id (never the domain).

### 3.5 File keys and signed links

Object keys today are `attachments/<id>`. New uploads use `tenants/<tenant id>/attachments/<id>`: an operator can see, size and delete one tenant's files by prefix, and a bug that confuses ids still cannot make a key outside the tenant's prefix. Rows keep the key they were stored with (`attachments.s3_key`), so old files (`attachments/<id>`, among them the `legacy` workspace's after `tenant-adopt`) need no copy and stay readable: the row's tenant check is the guard, not the prefix. A signed link is made only for the key of the row whose tenant has been checked; a row whose key lies under another tenant's prefix is refused. Import source objects (`imports/<id>/source.zip`) move under the tenant's prefix when imports are built (none exist yet). The bucket and its CORS rule stay shared.

### 3.6 Administrators and the first one

Today `GRIMOIRE_FIRST_ADMIN_EMAILS` makes named verified addresses administrators when they first sign in. With tenants (decided: question 2):

- **Tenant administrators:** the person who created a tenant is its first administrator, and can promote others. That is the only way a new workspace gets an administrator without the operator.
- **How the server knows who created it.** "First person the server sees" is not a signal: the creator finishes the flow, and a colleague of the same domain could reach the server first. The signal is a tenant role carried in the token, `tenants[<tenant id>].roles`: the `createTenant` step gives its creator the role (its inputs include the tenant's roles; the provider also assigns default roles), and joining by `update-user-tenant-email-domain` gives none. The server makes a person an administrator on their first sight only when the role is in their tenant's roles. Which role name and whether `createTenant` hands it to the creator by itself are checked on a throwaway project in step 2 of section 8, before the rule is written; test 10 of section 7 then covers the order (the colleague reaches the server first and is not the administrator).
- **The setting:** `GRIMOIRE_FIRST_ADMIN_EMAILS` stays, as the operator's way to make a named person an administrator of whatever tenant they sign into.
- **The operator:** there is no cross-tenant administrator in the application (decided: question 4). Looking across tenants is a database task with the migrator role.

### 3.7 Who may create a tenant

Anyone who can prove an address, which makes the domain the trust boundary. Decided (question 1): addresses at public mailbox providers do not become tenants. The server refuses the sign-in of a person whose domain is on a maintained list of public providers (`gmail.com`, `outlook.com`, and the rest: a data file in the repository with a test that pins its shape and a few members), and on the domains of the extra setting `GRIMOIRE_REFUSED_EMAIL_DOMAINS` (comma separated). There is no proof that the person owns the domain beyond receiving mail there: email delivery already proves control of an address on it. A DNS record as proof of the domain is a later option if a deployment needs it.

### 3.8 Limits for each tenant

Decided (question 6): before sign-up is open, each tenant has caps, from settings with defaults, each refused with a typed error and not a generic failure:

| Cap | Setting | Default | Refusal |
|---|---|---|---|
| people | `GRIMOIRE_TENANT_MAX_USERS` | 1,000 (the scale of decision 2) | a new person of a full tenant is refused at sign-in (`tenant-full`); existing people are not affected |
| storage | `GRIMOIRE_TENANT_MAX_STORAGE_BYTES` | 10 GiB | an upload is refused (`409`, `tenant-storage-full`) before a link is made |
| open pages | `GRIMOIRE_TENANT_MAX_PAGES` | 50,000 (not in the trash) | creating or restoring a page is refused (`409`, `tenant-pages-full`) |

The counts are read inside the same transaction as the write, under a per-tenant lock, so two requests cannot both pass the last slot. Tests: each cap refused at its limit and accepted one below it, a refusal that changes nothing, and one tenant at its cap never affecting another.

## 4. The sign-up settings

Today `GRIMOIRE_ALLOWED_EMAIL_DOMAINS` is the only gate: outside local mode an empty value is refused at startup, and the provisioner refuses every sign-in. An empty value must keep meaning nobody, or a deployment that leaves it unset (as `.env.example` and `compose.yaml` do) would go from refusing to start to open sign-up without any change by its operator. So open sign-up is explicit:

- `GRIMOIRE_OPEN_SIGNUP=1` allows any domain that is not refused (section 3.7). It cannot be combined with an allow-list (the startup refuses the pair).
- A non-empty `GRIMOIRE_ALLOWED_EMAIL_DOMAINS` stays an allow-list (a deployment that serves only some organisations, such as staging until tenancy is open).
- With neither, the startup refusal and the provisioner's refusal stay as they are.
- `GRIMOIRE_REFUSED_EMAIL_DOMAINS` is the extra refused domains (applies in both modes).

Until tenancy lands, staging keeps the allow-list with one domain and no open sign-up (decided: question 8).

## 5. Existing data (forward only)

No deployment holds data yet except development databases. The migration is forward only, like every other:

1. Make `tenants` and add `tenant_id` to every table as nullable, in one transaction.
2. Backfill every existing row with one tenant whose id is the fixed text `legacy`.
3. Make the columns not null, add the composite foreign keys (`on update cascade`) and the per-tenant unique indexes (this replaces the global ones). The row-level security policies are not enabled here: they come with step 7 of section 8, after the server sets `app.tenant` on every transaction (step 5), because until then the `nullif` policy would hide every row from the runtime role.
4. The command `grimoire tenant-adopt --from legacy --to <tenant id>` (decided: question 7, explicit, never automatic) moves the `legacy` workspace into a real tenant, in one transaction. The key strategy: every foreign key to `tenants(id)`, the composite ones included, is `on update cascade`, so renaming the `legacy` row rewrites every child row in the same statement. If a `tenants` row for the target already exists (made at its first sign-in), the command proceeds only when no tenant-owned table has a row for it (the target is empty): it deletes that empty row and renames `legacy` in its place; otherwise it refuses and changes nothing. Nothing runs it by itself.

New uploads use the new key prefix; old files keep their keys.

## 6. What the server does with each token

| Token | Result |
|---|---|
| valid, one key in `tenants`, and a tenant by the rule of section 2.1 (`dct` in `tenants`, or that one key) | the person is that tenant's; the user row is made on first sight with that `tenant_id` (a `member`, or an administrator by section 3.6) |
| valid, no `tenants`, or `dct` not in `tenants`, or more than one key in `tenants` (whatever `dct` says) | refused: `403` `no-tenant` (`tenant-ambiguous` for several tenants) on the API, a refusal at the collaboration handshake; a log line without personal data. The flow gives a new person a tenant before the token is made, so this is only a token from another flow or a person the provider has not yet assigned. |
| valid, the user row exists but belongs to another tenant than the claim | refused, and logged as a possible fault (the provider's claim and our row disagree). Not repaired by itself. |

## 7. Tests that must exist (written first, red first)

Two tenants A and B, each with an administrator, a member and a viewer, each with a collection, a page with a revision, a group, an attachment and a history. A test of isolation fails on the code of today (red first), then each change makes its part pass.

1. **API, by walking the routes.** For every operation of the registry (the policy walk already enumerates it), every id of B's data given by A answers 404 and changes nothing; every list of A contains none of B's rows; writes that name B's ids in the body (a group, a collection, a user, a parent page) are refused. A new route that has no entry fails the test (the walk is exhaustive, as the policy walk is).
2. **Collaboration.** A's token on B's page id is refused at the handshake, with the same refusal as a missing page; a connection open when A's person changes tenant is closed at the next re-check; awareness and presence of B's rooms are never sent to A.
3. **Files.** A cannot ask for a signed link, an upload or a completion for B's attachment id; a row whose key lies under another tenant's prefix is refused on read, while a row of the `legacy` kind (key `attachments/<id>`) is read through its own tenant check; a link made for A's file fetches only A's object.
4. **Search.** A's query never returns B's pages, titles or snippets, including for a word only B uses; the same query through the runtime role with no tenant set returns nothing (the backstop, if accepted).
5. **History and trash.** A cannot list, read or restore B's revisions, nor list, restore or purge B's trash.
6. **People and groups.** A's administrator cannot list, rename, suspend or change the role of B's users; group names may repeat across tenants; a member of B cannot be put in A's group.
7. **Audit and idempotency.** A's administrator sees only A's events; the same idempotency key from two tenants never replays across them.
8. **Jobs.** A job payload with a tenant id different from its row's is dropped and logged.
9. **Database.** With the runtime role and no tenant set, every tenant table returns no rows and refuses writes; a write with B's id while A's tenant is set is refused (if the policies are accepted). The migration test starts from the schema and data of today and ends with every row in the `legacy` tenant and every constraint in place.
10. **Sign-in.** A token without a usable tenant is refused on the API and at the handshake; a person's first sign-in makes their user row in the claim's tenant; the creator of a tenant (the tenant role of section 3.6) is its administrator and a second person of the same tenant joins it and is not, whichever of them reaches the server first; a token with several tenants is refused whatever `dct` says; a person of a refused domain, or of a full tenant, is refused with their typed reason.

## 8. Small pull requests, in this order

1. This document, accepted, with the decision and spec entries it changes.
2. The sign-in flow and the JWT template in code (both checked on a throwaway project already; the creator's tenant role of section 3.6 is checked there too), with the token carrying tenant and profile, and the staging stack's runtime key removed. Applied to a real project only on the owner's go-ahead for that stage.
3. The isolation tests, written first against today's code (red).
4. The migration: `tenants`, `tenant_id` everywhere, the legacy backfill, the composite keys with `on update cascade`, the per-tenant unique indexes.
5. The server reads the tenant from the verified token (with the several-tenants and no-tenant refusals, the creator's role, the refused and the allowed domains, and the open sign-up setting: the startup checks and the provisioner change together); every repository takes the tenant; the routes follow (several pull requests by area: pages and collections, people and groups, files, history and trash).
6. Collaboration admission and re-check by tenant; the key prefix of new uploads; the per-tenant caps (section 3.8).
7. Row-level security (decided, section 3.2).
8. `tenant-adopt`, the public-provider list as data, the documentation, and the staging switch to open sign-up.

## 9. Decisions and open questions

Answered by the owner (recorded as decided; the owner may still override):

1. **Public mailbox domains:** refuse a maintained list of public providers (a data file with a test) plus `GRIMOIRE_REFUSED_EMAIL_DOMAINS` for extras. No proof of the domain by DNS in the first version; noted as a later option (section 3.7).
2. **First administrator of a tenant:** the person who created it (section 3.6).
3. **Row-level security as a backstop:** yes (section 3.2).
4. **Operator role in the application:** none; cross-tenant work is a database task.
5. **More than one tenant for a person:** refused in the first version, whatever `dct` says.
6. **Per-tenant caps before open sign-up:** yes, for people, storage bytes and open pages, from settings with defaults, with typed refusals and tests (section 3.8).
7. **Existing development data:** `legacy` and the explicit `tenant-adopt`; no automatic adoption.
8. **Staging until tenancy lands:** closed to one domain; open sign-up only when steps 1 to 6 of section 8 are merged and the isolation tests pass.

Still open:

9. **The boundary of a workspace:** the full domain after the `@` (this document; simple, and `mail.example.com` is a tenant of its own) or the registrable domain (needs the public suffix list and a rule for subdomains)?
10. **The defaults of the caps** (section 3.8: 1,000 people, 10 GiB, 50,000 pages) are my proposal; are they right for the first deployment?
