# Sign-in with the identity provider: the manual check

Status: **not run.** This is an opt-in check against a real project of the identity provider. No default command, no test and no job of this repository needs a project id or a network connection beyond localhost: every automated sign-in uses the local development token, and the tests never reach the provider. Nothing below has been done; every result is `not run` until someone with the owner's approval runs it and fills the rows in.

The client signs in with the provider's web component and web SDK (decisions 94 and 96); the server validates the session with the provider's Node SDK. This check exercises that pair once, with a real session token.

## What the owner has to provide or approve first

| # | What | Why | State |
|---|---|---|---|
| 1 | The id of the **development** project (a public value, never the production project) | the sign-in component and the server need it | not provided |
| 2 | The web origin of the page registered as an approved origin of that project, for example the origin `scripts/serve.mjs` serves on | the provider refuses a sign-in from an origin it does not know | not done |
| 3 | The one-time-code sign-in method enabled, and a flow named `sign-up-or-in` | the component runs that flow | not done (a write to the project: approval of the exact operation first) |
| 4 | A test user: its login id, an email address in an allowed domain | a person has to sign in as someone | not done (creating a test user is a write: approval first) |
| 5 | For the automated job only: an environment named `descope-dev` with the management key (`DESCOPE_DEV_MANAGEMENT_KEY`, used for one call: the one-time code of the test user), the project id and the test user's login id as plain variables | the weekly job below | not done (creating the key is a write: approval first) |
| 6 | The settings of a server that is **not** in local mode: `GRIMOIRE_DESCOPE_PROJECT_ID`, `GRIMOIRE_ALLOWED_EMAIL_DOMAINS` (the test user's domain), `GRIMOIRE_FIRST_ADMIN_EMAILS` if the user should be an admin, `GRIMOIRE_ALLOWED_ORIGINS` with the web origin, `GRIMOIRE_PUBLIC_COLLAB_URL`, and `GRIMOIRE_DESCOPE_BASE_URL` for a regional project | outside local mode the server uses the provider's verifier, and the client gets the project id (and base URL) from `GET /v1/config` | not decided |

The check signs in and reads. It creates no user, changes no setting, flow or key and deletes nothing. A secret goes into no file of the repository, no log and no picture.

## Steps

1. Build the client for production (`bunx vite build` in `apps/web`) and serve it (`bun run --cwd apps/web serve`). A production build has no development sign-in and no design sample page.
2. Start the server outside local mode with the settings of row 6, against the development project, and put its address in `config.json` of the build.
3. Open the web origin. A signed-out visit goes to `/login?return=<page>`; the sign-in document asks `GET /v1/config`, finds a project id, and shows the provider's flow. Record item R3.
4. Open the browser's network panel and the console before signing in. Sign in as the test user with the one-time code. Record R7 (every host the sign-in page connected to, with the fingerprinting script's) and R8 (every policy violation the console reports).
5. After the redirect to the page asked for, read the browser's local storage: record R6 (which of `DS`, `DSR` and `DSI` exist and what kind of value each holds; never the value). Decode the session token's header and payload on the machine (not in an online tool): record R4 and R5.
6. Check that the app's own document never loaded the provider's scripts: in the network panel of the app page, record whether the session refresh loaded any script (CSP option C1).
7. Ask the server who the session belongs to: `GET /v1/me` with the session token answers 200 and the user the provider knows. Record R9, with whether the account was provisioned and with which role.
8. Repeat steps 4 and 5 under each of the two content-security-policy modes, the separate sign-in document (the default) and one policy for both documents (`app-wide`), and record C3. Render the headers of each mode with `node apps/web/scripts/render-headers.mjs --api-origin <origin> --collab-origin <origin> --store-origin <origin> [--signin app-wide] --out <folder>` and serve the build with `GRIMOIRE_WEB_HEADERS_DIR=<folder> node apps/web/scripts/serve.mjs`. The renderer takes `--fingerprint-connect` for the vendor's connect hosts once this check has listed them.
9. Try the options of CSP option C2 on the sign-in page and record what changes.
10. Sign out and check that `DS`, `DSR` and `DSI` are gone and that the session no longer works.

## What is recorded

Every row stays `not run` until the check is run.

| Id | Item | Result |
|---|---|---|
| R1 | The project id used, and that it is the development project | not run |
| R2 | The approved origin of the sign-in page | not run |
| R3 | The sign-in method, the flow id and the test user's login id | not run |
| R4 | The `iss` claim of the session token | not run |
| R5 | The lifetimes of the session token and of the refresh token | not run |
| R6 | The local storage keys `DS`, `DSR` and `DSI`: present or not, and the kind of value (never the value) | not run |
| R7 | The hosts the sign-in page connected to, with the fingerprinting script's | not run |
| R8 | The policy violations reported on the sign-in document and on the app | not run |
| R9 | `GET /v1/me` with the real session token: the status, and the account provisioned (domain rule, first admin) | not run |

## CSP options

The default is a separate sign-in document (`login.html`) with its own policy; the app's policy has no third-party origin. These rows say what that costs. They are run only in the opt-in check.

| Id | Question | Result |
|---|---|---|
| C1 | Does the SDK's session refresh in the app load any script? (The default mode needs none.) | not run |
| C2 | Does `@descope/web-component` 4.7.5 load its static assets from the app's own origin when `base-static-url` and `base-cdn-url` are set, so that `cdn.jsdelivr.net` can be dropped? Which origins remain? | not run |
| C3 | What does the browser report under the policy of each mode, the separate sign-in document and `app-wide`? (Render each mode with `scripts/render-headers.mjs`, step 8.) | not run |

## The automated job

A weekly job and a manual trigger, `descope-live-web`, is planned to repeat the sign-in against the development project in a local app started outside local mode. **It does not exist yet:** it is written with the end-to-end tests of the milestone. The only live-provider workflow today is `descope-live-m3.yml` (the server side: a real session token against the project's real key set), which is started by hand and ends green without a check, printing that the provider's development project is not provisioned, until the environment of row 5 exists. The job planned here, like that one, never runs on a pull request or on a fork, because a secret must not reach pull-request code, and its first step prints `blocked: Descope dev project not provisioned` and ends green without a check, so a missing secret is visible and never a silent pass.
