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

There is no state backend and no state file is committed (`.gitignore` blocks it),
so state lives only inside one run and is lost when it ends. That is safe here
because of what is managed:

- The project already exists and is not managed, so a lost state can never orphan
  or duplicate a project.
- Both resources are singletons whose id is the project id, so there is exactly one
  object each. `imports.tf` imports them at the start of every run, which rebuilds
  the state from the project itself. A run therefore plans the real difference
  (settings in the project against these files), never a create.
- Nothing here creates an object with an id the state alone remembers.

The cost: removing a resource from these files does not undo it in the project (the
run has no memory of it), and an apply sets only the fields written in `main.tf`.
Read every plan before an apply. If resources that create objects are added later
(flows, roles, tenants), add a remote backend first. `.terraform.lock.hcl` is
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

`.github/workflows/descope-infra.yml`:

- Pull requests touching this folder run only `init -backend=false`, `validate` and `fmt -check`, with no secret and no environment, because a secret must not reach pull-request code.
- `plan` and `apply` run only on a manual dispatch of `main`, with the environment `descope-dev` and its secret `DESCOPE_DEV_MANAGEMENT_KEY`. Both skip with a notice while the secret is not set.
- The owner should also set the environment's deployment branch to `main` and add required reviewers. Run `plan` first and read it, then dispatch `apply`.
