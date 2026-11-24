# Descope development project (infrastructure as code)

OpenTofu configuration for the settings of the **development** project
"Grimoire dev" that the sign-in needs. It follows the `descope-terraform` skill
(see [the skills notice](../../.agents/skills/DESCOPE-SKILLS-NOTICE.md)). The
production project is never touched by this folder.

## What it manages

| Resource | Setting |
|---|---|
| `descope_project_settings` | approved domains `127.0.0.1` and `localhost` (hosts only, no port: the web page on port 4173 and the stack on port 8080 are both covered), the app URL |
| `descope_otp_settings` | one-time code by email is on |

## What it does not manage

- The project itself (it already exists; only its settings are managed).
- The `sign-up-or-in` flow. The provider can manage it (`descope_flow`), but that needs the flow's exported JSON, which only the console or the management API can give. Until that file is reviewed and committed, the flow stays as it is in the project.
- Passkeys, roles, tenants and widgets: the spec's sign-in does not use them.
- Test users: the provider has only a static code for test users, which is a secret. Create test users with the management API when the live check needs one.

## State

No state file is committed (`.gitignore` blocks it) and no remote state is used.
Both resources are singletons whose id is the project id, and `imports.tf` imports
them on every run, so a run that starts with empty state plans the real difference
instead of a create. Read every plan before an apply. `.terraform.lock.hcl` is
committed to pin the provider's checksums.

## Run locally

```sh
mise install
export DESCOPE_MANAGEMENT_KEY=...   # a development project key; never commit it
cd infra/descope
tofu init
tofu plan
```

## CI

`.github/workflows/descope-infra.yml` runs `plan` on pull requests that touch this folder and
`apply` only on manual dispatch. Both use the environment `descope-dev` and its secret
`DESCOPE_DEV_MANAGEMENT_KEY`.
