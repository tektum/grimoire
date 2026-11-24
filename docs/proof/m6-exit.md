# The exit test of the web client (M6)

What proves each behaviour of the web client, and how the exit test runs. `make test-m6` runs the scenarios below in Chromium, Firefox and WebKit against the stack (`compose.m6.yaml`, with the handshake required), and checks the list of scenarios against this report. A row that is `pending` names the task whose screen is not built yet: it is listed, with the files that will prove it, and is neither skipped nor counted as proved. `apps/web/test-e2e/m6/exit.spec.ts` checks this report: every file it names exists unless the row is pending, and every pending row names a task.

## How to run it

```sh
bun install --frozen-lockfile && make down && make up && make test-m6 && make down && bun run licence
```

`make test-m6` installs the browsers if they are missing (and stops with `playwright browsers missing` if it cannot), builds the client in `e2e` mode, runs `check:build`, starts the stack with `M6_REQUIRE_HANDSHAKE=1`, serves the client on 4173 (a different origin from the API on 8080), checks the list of scenarios, and runs the files of the scenarios that are not pending, once in each browser. The list and the report are `apps/web/test-e2e/m6/scenarios.ts` and this file. A real sign-in with the identity provider is not part of it.

## The scenarios

| Scenario | What is shown | Specifications | State |
|---|---|---|---|
| `co-edit` | Two people sign in with development tokens, edit one paragraph and keep each other's text | `apps/web/test-e2e/editor/co-edit.spec.ts` | proved |
| `cursors` | Remote cursors carry the names of the people | `apps/web/test-e2e/editor/remote-cursors.spec.ts` | proved |
| `soft-lock` | The soft lock refuses a change of structure and names the person who is in the block | `apps/web/test-e2e/lock/lock.spec.ts` | proved |
| `offline` | An edit made offline is kept and merged on reconnect | `apps/web/test-e2e/editor/offline.spec.ts` | proved |
| `status-messages` | Every status message is shown for the signal that causes it, with the server stopped and with the scripted server | `apps/web/test-e2e/status/messages.spec.ts`<br>`apps/web/test-e2e/editor/signal-rows.spec.ts`<br>`apps/web/test-e2e/editor/connection-signals.spec.ts` | proved |
| `images` | An image pasted into a page is uploaded, and an expired image address is refreshed | `apps/web/test-e2e/attachments/upload-flow.spec.ts`<br>`apps/web/test-e2e/attachments/url-refresh.spec.ts` | proved |
| `search-palette` | Search and the palette find a page and open it | (to come) | pending M6-T09 |
| `history-restore` | A restored version is seen by the second browser | `apps/web/test-e2e/history/restore.spec.ts` | proved |
| `admin` | The admin screens change a role, a group and the access of a collection | `apps/web/test-e2e/admin/admin.spec.ts` | proved |
| `import` | The import screen takes a file into a collection | (to come) | pending M6-T12a |
| `xss` | Hostile content is shown as text or refused: links, images, raw HTML, names and titles | `apps/web/test-e2e/editor/unsafe-links.spec.ts`<br>`apps/web/test-e2e/history/safety.spec.ts`<br>`apps/web/test-e2e/safety/raw-html.spec.ts`<br>`apps/web/test-e2e/attachments/corpus-images.spec.ts` | proved |
| `axe` | Axe finds nothing serious on every route, in the light and the dark scheme | `apps/web/test-e2e/a11y/tour.spec.ts` | proved |
| `origins` | The web origin differs from the API origin in every request, and no request carries a cookie | `apps/web/test-e2e/m6/origins.spec.ts` | proved |
| `handshake` | The server requires the handshake: a bare token is refused | `apps/web/test-e2e/m6/handshake.spec.ts` | proved |
| `mutation` | A broken `mapSignal` row and a broken `isSafeHref` rule make the checks fail | `apps/web/test-e2e/m6/mutation.spec.ts` | proved |

The build step `bun run --filter apps/web check:build` is part of the run, before the stack starts.

## What proves each behaviour

| Area | Behaviour | Proof | State |
|---|---|---|---|
| Shell, configuration and build (M6-T01) | Every version of the specification is present exactly: bun pm ls output is compared with the table by deps.test.ts, which fails on a missing, extra. | `apps/web/test/unit/deps.test.ts` | proved |
| Shell, configuration and build (M6-T01) | bun run --filter @tektum/grimoire-web build then bun run --filter @tektum/grimoire-web check:build exits 0. | `apps/web/test/unit/cross-origin.test.ts` | proved |
| Shell, configuration and build (M6-T01) | One lint fixture per rule (localStorage, sessionStorage, indexedDB, document.cookie, fetch, console) is rejected outside its allowed folders and accepted inside. | `apps/web/test/unit/lint.test.ts` | proved |
| Shell, configuration and build (M6-T01) | Every path of the specification renders its stub. | `apps/web/test/unit/routes.test.ts` | proved |
| Shell, configuration and build (M6-T01) | 401 then 200 gives exactly two calls and one refresh. | `apps/web/test/unit/api.test.ts` | proved |
| Shell, configuration and build (M6-T01) | The markdown and revision-body queries have gcTime 0 and no query key holds document content. | `apps/web/test/unit/query.test.tsx` | proved |
| Shell, configuration and build (M6-T01) | Tokens exist in light and dark; the collaborator palette label contrast is at least 4.5:1 in both themes; prefers-reduced-motion removes transitions (CSS text test). | `apps/web/test/unit/ui.test.ts` | proved |
| Shell, configuration and build (M6-T01) | Tsconfig.json has no outDir inside dist, and after bun run build (root tsc -b) followed by vite build the dist folder still holds index.html, login.html and. | `apps/web/test/unit/tsconfig.test.ts` | proved |
| Shell, configuration and build (M6-T01) | Vitest.config.js check (vitest-config.test.ts): bun run test runs the web project once and the unit project does not match any file under. | `apps/web/test/unit/vitest-config.test.ts` | proved |
| Shell, configuration and build (M6-T01) | A mutation of an operation marked idempotent sends Idempotency-Key (a UUID), a retry after 429 or 503 sends the same key, a new user action sends a new one, an operation. | `apps/web/test/unit/idempotency.test.ts` | proved |
| Shell, configuration and build (M6-T01) | Api.test.ts also covers 409 markdown_stale: it is not a retry case, it reaches the caller as a typed MarkdownStale result, and the message text exists. | `apps/web/test/unit/api.test.ts` | proved |
| Shell, configuration and build (M6-T01) | The licence report accepts every package the client ships: `bun run licence` exits 0. | `.github/workflows/ci.yml` | proved |
| Shell, configuration and build (M6-T01) | Changing `config.json` changes the requests of the running app without a rebuild. | `apps/web/test/unit/config.test.ts` | proved |
| Shell, configuration and build (M6-T01) | The headers template sends `Referrer-Policy: no-referrer`. | `apps/web/test/safety/headers.test.ts` | proved |
| Test support (M6-T01a) | Corpus.test.ts passes: the corpus has at least 40 entries, unique ids, and every scheme of the specification appears at least once. | `apps/web/test/support/corpus.test.ts` | proved |
| Test support (M6-T01a) | The token built by signInAs matches ^dev:[A-Za-z0-9_-]{16,128}:[a-z0-9_-]{1,64}:(admin/member/viewer)$, is at most 256 characters, an uppercase user id is refused by the. | `apps/web/test/support/dev-token.test.ts` | proved |
| Test support (M6-T01a) | The test support signs in, opens two browsers, waits for sync and runs axe against the stack. | `apps/web/test-e2e/support/self-test.spec.ts` | proved |
| Test support (M6-T01a) | With the browsers absent and no network, the browser check exits 1 and prints "playwright browsers missing". | `apps/web/test-e2e/support/helpers.spec.ts` | proved |
| Test support (M6-T01a) | The web overlay of Compose sets the two web origins and changes nothing else. | `apps/server/test/server/compose-settings.test.ts` | proved |
| Sign-in and session (M6-T02) | GetToken returns the stored dev token; with a Descope session it asks the SDK to refresh a token that expires within 60 s; refresh() false after a failed refresh. | `apps/web/test/auth/auth.test.ts` | proved |
| Sign-in and session (M6-T02) | With local: true the form (user id, role, secret from the test environment) signs in alice as member, GET /v1/me returns her, the request has an Authorization: Bearer. | `apps/web/test-e2e/auth/dev-signin.spec.ts` | proved |
| Sign-in and session (M6-T02) | On a signed-in start the network log has no request to fpnpmcdn.net, descopecdn.com or static.descope.com. | `apps/web/test-e2e/auth/descope-chunk.spec.ts` | proved |
| Sign-in and session (M6-T02) | A config answer minClientVersion 9.0.0 against client 1.2.3 renders only "A new version is available. | `apps/web/test/auth/gate.test.tsx` | proved |
| Sign-in and session (M6-T02) | Every request of the wrapper carries X-Grimoire-Client-Version equal to CLIENT_VERSION. | `apps/web/test/auth/version.test.tsx` | proved |
| Sign-in and session (M6-T02) | The app shows the reload text on the gate; the same page with 0.0.0 loads. | `apps/web/test-e2e/auth/client-too-old.spec.ts` | proved |
| Sign-in and session (M6-T02) | Account_suspended and not_allowed sign out with the texts of the specification. | `apps/web/test/auth/suspended.test.ts` | proved |
| Sign-in and session (M6-T02) | M6-signin-manual.md exists, lists the nine recording items and has no row other than not run (a script check). | `docs/proof/m6-signin-manual.md` | proved |
| Sign-in and session (M6-T02) | Vite build output has login.html and index.html. | `apps/web/test/auth/login-document.test.ts`<br>`apps/web/test-e2e/auth/login-redirect.spec.ts` | proved |
| Sign-in and session (M6-T02) | CSP experiment recorded in m6-signin-manual.md (section "CSP options", run only in the opt-in manual check, rows not run until then): (1) does the SDK's. | `docs/proof/m6-signin-manual.md` | proved |
| Sign-in and session (M6-T02) | The form's token matches ^dev:[A-Za-z0-9_-]{16,128}:[a-z0-9_-]{1,64}:(admin/member/viewer)$, an uppercase user id and a secret shorter than 16 characters are refused by. | `apps/web/test/auth/dev-token.test.ts` | proved |
| Sign-in and session (M6-T02) | The production build has no sign-in provider code in its entry chunks. | `apps/web/scripts/check-build.mjs` | proved |
| Contents tree, trash, not found (M6-T03) | After "New page" the tree list text equals ['Welcome','Nested','Untitled']. | `apps/web/test-e2e/collections/tree.spec.ts` | proved |
| Contents tree, trash, not found (M6-T03) | The tree refetches on window focus and every 60 s: a test counts GET /v1/collections/{id}/tree requests after dispatching focus (exactly 1 more) and after a faked 60 s. | `apps/web/test-e2e/collections/tree-refetch.spec.ts` | proved |
| Contents tree, trash, not found (M6-T03) | A user without access opens /p/<slug> and sees the not-found screen with the same text as for an unknown id and the same HTTP-visible behaviour (both 404 from the API). | `apps/web/test-e2e/collections/not-found.spec.ts` | proved |
| Contents tree, trash, not found (M6-T03) | Keyboard only: a test moves a page with Tab, Enter on the row menu and the dialog, without a pointer event (page.mouse not used). | `apps/web/test-e2e/collections/keyboard-move.spec.ts` | proved |
| Contents tree, trash, not found (M6-T03) | 5,000 generated nodes render the first screen in under 500 ms in a unit-level benchmark in Chromium (tree-perf.spec.ts, budget with 10x. | `apps/web/test-e2e/collections/tree-perf.spec.ts` | proved |
| Contents tree, trash, not found (M6-T03) | A 409 would_create_cycle shows "A page can't be moved into itself or its own sub-pages" and the tree refetches (route interception). | `apps/web/test-e2e/collections/conflict.spec.ts` | proved |
| Contents tree, trash, not found (M6-T03) | Axe reports no serious or critical violation on /c/:id, /trash and the not-found screen. | `apps/web/test-e2e/collections/axe.spec.ts` | proved |
| Editor and connection (M6-T04) | Connection-signals.spec.ts drives the real server into forbidden, not-found, invalid-token, access-changed (admin reset. | `apps/web/test-e2e/editor/connection-signals.spec.ts` | proved |
| Editor and connection (M6-T04) | map-signal.test.ts is table-driven over every row of the table of the specification (reason, code, behaviour, text) and fails when a row is. | `apps/web/test/editor/map-signal.test.ts` | proved |
| Editor and connection (M6-T04) | Both edit the same paragraph and both texts survive. | `apps/web/test-e2e/editor/co-edit.spec.ts` | proved |
| Editor and connection (M6-T04) | A second client publishes through a hand-built awareness frame user: { id: <its own id>, name: 'Forged', color: '#ff0000' }. | `apps/web/test-e2e/editor/forged-presence.spec.ts` | proved |
| Editor and connection (M6-T04) | The read-only saved Markdown (contenteditable false) is visible before the provider synced (the provider is delayed 1 s by a scripted server) and is replaced by exactly. | `apps/web/test-e2e/editor/open.spec.ts` | proved |
| Editor and connection (M6-T04) | Read-only toggle: switching the scope to read-only through the server (role downgrade, then the 60 s recheck scaled by GRIMOIRE_COLLAB_RECHECK_SECONDS=2) reconnects. | `apps/web/test-e2e/editor/access-changes.spec.ts` | proved |
| Editor and connection (M6-T04) | Reset: an admin reset-state while browser B is connected closes B (stale-epoch 4409 from the refused save, or access-changed 4205 from the re-check, whichever comes. | `apps/web/test-e2e/editor/stale-epoch.spec.ts` | proved |
| Editor and connection (M6-T04) | Offline: a test goes offline (context.setOffline(true)), types, waits 11 s (scaled by config), sees "Offline: changes kept in this tab", goes online and the other. | `apps/web/test-e2e/editor/offline.spec.ts` | proved |
| Editor and connection (M6-T04) | Hidden tab: with hiddenDisconnectMs 3000 the provider status becomes disconnected 3 s after the tab is hidden and connected after it is shown. | `apps/web/test-e2e/editor/hidden-tab.spec.ts` | proved |
| Editor and connection (M6-T04) | Epoch handshake stale-epoch.spec.ts: A opens a page and types old. | `apps/web/test-e2e/editor/stale-epoch.spec.ts`<br>`apps/web/test-e2e/editor/reset-copy.spec.ts` | proved |
| Editor and connection (M6-T04) | The real provider's first connect and its automatic reconnect after docker compose restart app each present a handshake token to the server (the server's. | `apps/web/test-e2e/editor/handshake-transport.spec.ts` | proved |
| Editor and connection (M6-T04) | The token function returns g1. plus base64url of {t, v} on a first connect and {t, v, e} after an epoch was recorded, decodes back to the same object, never exceeds. | `apps/web/test/editor/handshake-token.test.ts` | proved |
| Editor and connection (M6-T04) | A tab that holds a non-empty document but has no recorded epoch (the scripted server dropped the socket before the epoch message) destroys the document and creates a. | `apps/web/test/editor/connection-manager.test.ts` | proved |
| Editor and connection (M6-T04) | V of the handshake token equals CLIENT_VERSION on every connect. | `apps/web/test-e2e/editor/client-version.spec.ts` | proved |
| Editor and connection (M6-T04) | Awareness throttle: a unit test with fake timers shows at most 4 awareness updates in 1 s for 100 selection changes. | `apps/web/test/editor/awareness-throttle.test.ts` | proved |
| Editor and connection (M6-T04) | The node and mark names of the mounted editor equal those of grimoireEditorPlugins alone. | `apps/web/test/editor/editor-schema-untouched.test.ts` | proved |
| Editor and connection (M6-T04) | Close code 4501 is never retried (M2-T04 follow-up):: no-retry-4501.test.ts (fake socket and clock): after a refusal seed-failed (close code. | `apps/web/test/connection/no-retry-4501.test.ts` | proved |
| Editor and connection (M6-T04) | Stale epoch is never a silent reconnect (M2-T06 verification finding):: stale-close.test.ts (fake provider and clock): a close with code 4409. | `apps/web/test/connection/stale-close.test.ts` | proved |
| Editor and connection (M6-T04) | Pre-sign-in window (security finding on the unauthenticated socket cap):: the provider's token callback returns a cached or just-refreshed session token within 2. | `apps/web/test/connection/preauth.test.ts` | proved |
| Editor and connection (M6-T04) | Remote cursors are always visible :: remote-cursors.spec.ts : each other person's caret. | `apps/web/test-e2e/editor/remote-cursors.spec.ts` | proved |
| Editor and connection (M6-T04) | On a close with reason access-changed the held Markdown copy exists before the document is destroyed. | `apps/web/test/connection/copy-before-fresh.test.ts` | proved |
| Editor and connection (M6-T04) | A refusal seed-failed (4501) schedules no reconnect (fake clock, ten minutes) and shows the message with its button. | `apps/web/test/connection/no-retry.test.ts` | proved |
| Editor and connection (M6-T04) | The page opens and syncs, and the scripted-server log shows every connection's token starts with g1. | `apps/web/test-e2e/editor/require-handshake.spec.ts` | proved |
| Editor and connection (M6-T04) | A pasted /p/<slug>-<urlId> for a page the user can read opens it. | `apps/web/test-e2e/editor/open-by-link.spec.ts` | proved |
| Editor and connection (M6-T04) | A page flagged stale shows 'This text may be a few seconds behind the live page.' in the read-only first view and the label is gone once the editor is live. | `apps/web/test-e2e/editor/stale-markdown.spec.ts` | proved |
| Editor and connection (M6-T04) | After the database is emptied and the pages restored at a lower epoch, the tab offers its copy and does not overwrite. | `apps/web/test-e2e/editor/handshake-restore.spec.ts` | proved |
| Menus and soft lock (M6-T05) | While B types in a paragraph, A converts it to a heading. | `apps/web/test-e2e/lock/heading.spec.ts` | proved |
| Menus and soft lock (M6-T05) | With B's cursor in a block, A choosing "Bullet list" from the slash or handle menu leaves the block unchanged and shows exactly Bob is editing this block (B's directory. | `apps/web/test-e2e/lock/lock.spec.ts` | proved |
| Menus and soft lock (M6-T05) | A typed # sets level 1 on the existing paragraph without creating a new node (unit-level check through the editor in Playwright reading the Yjs fragment). | `apps/web/test-e2e/lock/level.spec.ts` | proved |
| Menus and soft lock (M6-T05) | The slash menu lists the block kinds of the schema, opens on /, is operable with arrow keys and Enter, and each item's accessible name is non-empty (axe plus a count of. | `apps/web/test-e2e/lock/slash.spec.ts` | proved |
| Menus and soft lock (M6-T05) | The link editor refuses javascript: and file: with "Only web, mail and relative links are allowed" and accepts https://example.com, mailto:a@b.test and /p/x (Playwright). | `apps/web/test-e2e/lock/link-editor.spec.ts` | proved |
| Menus and soft lock (M6-T05) | Plugin-trailing against docWithoutTrailingEmpties: typing at the end of a document whose last block is a table gives the same Markdown after two saves (the saved. | `apps/web/test-e2e/lock/trailing.spec.ts` | proved |
| Menus and soft lock (M6-T05) | The help text of R3.15 exists on the lock message's "Why?" action (exact text asserted). | `apps/web/test-e2e/lock/help-text.spec.ts` | proved |
| Menus and soft lock (M6-T05) | Axe reports no serious or critical violation with the slash menu and the bubble open. | `apps/web/test-e2e/lock/axe.spec.ts` | proved |
| Menus and soft lock (M6-T05) | The help text of R3.26 exists on the lock message's "Why?" action and on the help page, its exact text is asserted, and it names the three actions (splitting, joining. | `apps/web/test-e2e/lock/help-limit.spec.ts` | proved |
| Tables and code blocks (M6-T05a) | In a 2x2 table "Add row below" gives 3 rows, "Delete column" gives 2 columns on 2 rows, and the saved Markdown (GET /markdown) matches the expected pipe table text. | `apps/web/test-e2e/tables/tables.spec.ts` | proved |
| Tables and code blocks (M6-T05a) | Every control has an accessible name and is reachable by keyboard (Tab order test). | `apps/web/test-e2e/tables/keyboard.spec.ts` | proved |
| Tables and code blocks (M6-T05a) | The language picker sets language to ts and the saved Markdown fence reads ts. | `apps/web/test-e2e/tables/code-language.spec.ts` | proved |
| Outline (M6-T05b) | A page with headings A (level 1), B (level 2) and C (level 1) shows the outline items A, B, C in that order with B indented one level more. | `apps/web/test-e2e/outline/outline.spec.ts` | proved |
| Outline (M6-T05b) | A heading typed by the second user appears in the first user's outline. | `apps/web/test-e2e/outline/two-users.spec.ts` | proved |
| Outline (M6-T05b) | Tab reaches the outline, arrow keys and Enter move to a heading, no page.mouse call. | `apps/web/test-e2e/outline/keyboard.spec.ts` | proved |
| Outline (M6-T05b) | An empty page renders no list and no empty nav. | `apps/web/test/outline/outline.test.tsx` | proved |
| Outline (M6-T05b) | Headings of levels 1 to 6 all appear in order, the indentation of level 4, 5 and 6 equals that of level 4 (cap), and a paragraph with level 0 is not listed. | `apps/web/test/outline/levels.test.tsx` | proved |
| Status line and messages (M6-T06) | Messages.spec.ts has one test per row of the specification that has a text. | `apps/web/test-e2e/status/messages.spec.ts` | proved |
| Status line and messages (M6-T06) | "Saving" appears within 1 s of a keystroke and "Saved" after the server acknowledged (unsyncedChanges 0). | `apps/web/test-e2e/status/saved.spec.ts` | proved |
| Status line and messages (M6-T06) | The live region (role="status", aria-live="polite") receives "Saved", the connection-loss text and each refusal text without focus moving (document.activeElement. | `apps/web/test-e2e/status/live-region.spec.ts` | proved |
| Status line and messages (M6-T06) | 100th editor: with the page cap set to 1 the second browser shows "This page already has 100 people editing. | `apps/web/test-e2e/status/page-full.spec.ts` | proved |
| Status line and messages (M6-T06) | A broken mapping fails: a committed mutation test changes one behaviour in mapSignal and the table test fails. | `apps/web/test/status/mutation.test.ts` | proved |
| Status line and messages (M6-T06) | Axe reports no serious or critical violation with each message shown. | `apps/web/test-e2e/status/axe.spec.ts` | proved |
| Status line and messages (M6-T06) | Every row of the corrected table of the specification has a message test title (the existing title-versus-table check), including seed-failed and the 4429 pair. | `apps/web/test/status/rows.test.ts` | proved |
| History (M6-T07) | A restores an older revision; B, connected to the page, shows the restored text within 5 s. | `apps/web/test-e2e/history/restore.spec.ts` | proved |
| History (M6-T07) | A viewer sees no element with role button named "Restore" (role query) and a direct POST attempt answers 403 (route check). | `apps/web/test-e2e/history/viewer.spec.ts` | proved |
| History (M6-T07) | The diff view renders added lines as ins elements and removed lines as del elements: counts equal those of diff.diffLines on a fixed pair (unit test with the same pair). | `apps/web/test/history/diff.test.tsx` | proved |
| History (M6-T07) | Revision Markdown containing the corpus link and HTML entries renders no <a> with an unsafe href and no executed script. | `apps/web/test-e2e/history/safety.spec.ts` | proved |
| History (M6-T07) | Axe reports no serious or critical violation on the list, one revision and the diff. | `apps/web/test-e2e/history/axe.spec.ts` | proved |
| History (M6-T07) | The message above appears, the revision stays open, no navigation happens, and a second click after an interception that answers 200 restores and navigates. | `apps/web/test-e2e/history/restore-stale.spec.ts` | proved |
| Images and files (M6-T08) | Pasting a PNG logs the requests in order POST /v1/attachments, PUT to the store origin, POST /v1/attachments/{id}/complete. | `apps/web/test-e2e/attachments/upload.spec.ts` | proved |
| Images and files (M6-T08) | An expired image URL (route interception returns 403 once) is refreshed with one more POST /v1/attachments/urls and the image loads without a page reload. | `apps/web/test-e2e/attachments/url-refresh.spec.ts` | proved |
| Images and files (M6-T08) | A .exe file shows "That file type isn't allowed". | `apps/web/test-e2e/attachments/refused.spec.ts` | proved |
| Images and files (M6-T08) | A Markdown image with src https://evil.test/p.png or a data: URI renders the placeholder "External image not loaded: evil.test" and no request to that host is made. | `apps/web/test-e2e/attachments/external-image.spec.ts` | proved |
| Images and files (M6-T08) | Clicking an attachment link requests a signed URL at that moment (one GET /v1/attachments/{id}) and never uses a header-less link. | `apps/web/test-e2e/attachments/download.spec.ts` | proved |
| Images and files (M6-T08) | Axe reports no serious or critical violation on a page with an image and an attachment. | `apps/web/test-e2e/attachments/axe.spec.ts` | proved |
| Images and files (M6-T08) | After an upload the saved Markdown (read through GET /v1/pages/{id}/markdown) holds ![name](attachments/<uuid>/<cleaned name>). | `apps/web/test-e2e/attachments/markdown-path.spec.ts` | proved |
| Images and files (M6-T08) | The eleventh parallel upload shows 'Too many uploads at once. | `apps/web/test-e2e/attachments/cap.spec.ts` | proved |
| Search and palette (M6-T09) | A result with matchedPassage.text containing <img src=x onerror=alert(1)> shows it as literal text and no script runs, a 300-character passage wraps without horizontal. | `apps/web/test-e2e/search/passage.spec.ts` | pending M6-T09 |
| Search and palette (M6-T09) | Mod-K opens the dialog with focus in the input. | `apps/web/test-e2e/search/palette.spec.ts` | pending M6-T09 |
| Search and palette (M6-T09) | A snippet { text: 'a <script>alert(1)</script> x', ranges: [[28, 29]] } renders the literal text <script> and one mark element around x, ranges outside the text or. | `apps/web/test/search/snippet.test.ts` | pending M6-T09 |
| Search and palette (M6-T09) | A result with partial: true (a 1 MB page of distinct words, Q35 = B) shows "Only the beginning of this page is searchable" and one without it does not. | `apps/web/test-e2e/search/partial.spec.ts` | pending M6-T09 |
| Search and palette (M6-T09) | The results screen paginates with nextCursor (a second request carries the cursor) and shows "No results" for an empty list. | `apps/web/test-e2e/search/results.spec.ts` | pending M6-T09 |
| Search and palette (M6-T09) | Axe reports no serious or critical violation on /search and with the palette open. | `apps/web/test-e2e/search/axe.spec.ts` | pending M6-T09 |
| Accessibility (M6-T10) | Every route's primary action is reached and used with the keyboard only (no page.mouse and no click on an element not focused by Tab or arrow keys), including moving a. | `apps/web/test-e2e/a11y/keyboard.spec.ts` | proved |
| Accessibility (M6-T10) | With emulateMedia({ reducedMotion: 'reduce' }) no element has a non-zero computed transition-duration or animation-duration on any route. | `apps/web/test-e2e/a11y/reduced-motion.spec.ts` | proved |
| Accessibility (M6-T10) | M6-accessibility.md has one section per pass target (NVDA with Firefox, VoiceOver with Safari) and a table whose every fail row has a task id. | `docs/proof/m6-accessibility.md` | proved |
| Accessibility (M6-T10) | Every route, and the editor with its menus and dialogs, has no serious or critical axe violation, in both schemes. | `apps/web/test-e2e/a11y/tour.spec.ts` | proved |
| Rendering safety (M6-T11) | Render-headers.mjs writes headers.json with exactly the keys /index.html and /login.html, each value equal to the header lines of the corresponding block of the headers. | `apps/web/test/safety/headers-json.test.ts` | proved |
| Rendering safety (M6-T11) | IsSafeHref is true for https://a.test, http://a.test, mailto:a@b.test, tel:+1555, ftp://a.test/x, /x, ./x, ../x, #a, ?q=1 and false for every unsafe entry of the corpus. | `apps/web/test/safety/href.test.ts` | proved |
| Rendering safety (M6-T11) | Every corpus entry rendered through import-style Markdown, through paste and through the editor produces no dialog, no request to a host outside the page's origin, the. | `apps/web/test-e2e/safety/corpus.spec.ts` | pending M6-T11 |
| Rendering safety (M6-T11) | The three Milkdown-blanked schemes still render href="" (so a Milkdown upgrade cannot regress silently), and a click on an ftp: link does not navigate. | `apps/web/test-e2e/safety/milkdown-guard.spec.ts` | pending M6-T11 |
| Rendering safety (M6-T11) | Raw HTML renders as escaped text inside a non-editable block with a button named "Edit source". | `apps/web/test-e2e/safety/raw-html.spec.ts` | proved |
| Rendering safety (M6-T11) | Pasted HTML containing script, iframe, onclick, style and a javascript: link yields a document with only text and safe links (Markdown compared). | `apps/web/test-e2e/safety/paste.spec.ts` | pending M6-T11 |
| Rendering safety (M6-T11) | Headers.test.ts renders headers in both modes with three origins. | `apps/web/test/safety/headers.test.ts` | proved |
| Rendering safety (M6-T11) | Docs/web-security.md exists and contains the strings fpnpmcdn.net, DSR and Apache-2.0 (script check). | `docs/web-security.md` | proved |
| Rendering safety (M6-T11) | Presence names are untrusted :: presence-name.test.tsx: a collaborator name of <img src=x onerror=alert(1)>, a name of. | `apps/web/test/editor/cursor.test.ts` | proved |
| Rendering safety (M6-T11) | In both modes connect-src and img-src of the app document contain the store origin and connect-src contains the collaboration origin with its ws: or wss: scheme written. | `apps/web/test/safety/headers.test.ts` | proved |
| Rendering safety (M6-T11) | For every corpus href, isSafeHref(h) equals isSafeUrl(h, 'link') of editor-schema (the import is checked by grep, and the file defines no scheme list of its own). | `apps/web/test/safety/href-parity.test.ts` | proved |
| Rendering safety (M6-T11) | The built app served with its rendered headers loads, signs in and opens a page with no CSP violation and no script error. | `apps/web/test-e2e/m6/origins.spec.ts` | proved |
| Admin (M6-T12) | An admin changes a user's role (the next GET /v1/users shows it), suspends a user (that user's next call shows "Your account is suspended"), creates a group, adds and. | `apps/web/test-e2e/admin/admin.spec.ts` | proved |
| Admin (M6-T12) | A member and a viewer opening /admin/users see the not-found screen and no admin request is made (network log). | `apps/web/test-e2e/admin/access.spec.ts` | proved |
| Admin (M6-T12) | Demoting the last admin shows "There must be at least one admin" (409 last_admin). | `apps/web/test-e2e/admin/last-admin.spec.ts` | proved |
| Admin (M6-T12) | The reset action asks for confirmation naming the page, calls POST /v1/pages/{id}/reset-state once and shows the result. | `apps/web/test-e2e/admin/reset.spec.ts` | proved |
| Admin (M6-T12) | Axe reports no serious or critical violation on the three admin screens. | `apps/web/test-e2e/admin/axe.spec.ts` | proved |
| Admin (M6-T12) | The first call shows the stale warning, nothing is sent until the admin confirms, the second call carries confirmStale: true, and the result line says the page was reset. | `apps/web/test-e2e/admin/reset-stale.spec.ts` | proved |
| Admin (M6-T12) | The users screen offers no element named 'Delete' for a user (role query), only 'Suspend' or 'Reinstate'. | `apps/web/test-e2e/admin/no-delete.spec.ts` | proved |
| Import (M6-T12a) | Progress 0, 40 and 100 percent render as progressbar values. | `apps/web/test/import/import.test.tsx` | pending M6-T12a |
| Import (M6-T12a) | A small generated zip imports; the report row count equals the number of files; cancelling a second import while running shows "Cancelled. The pages it created were. | `apps/web/test-e2e/import/import.spec.ts` | pending M6-T12a |
| Import (M6-T12a) | Only writers see /import (a viewer gets the not-found screen). | `apps/web/test-e2e/import/writers.spec.ts` | pending M6-T12a |
| Import (M6-T12a) | Axe reports no serious or critical violation on the screen in each state. | `apps/web/test-e2e/import/axe.spec.ts` | pending M6-T12a |
| Browsers and exit (M6-T13) | A real sign-in of the existing test user through the Descope component on login.html, GET /v1/me returns that user, a page created in the local test database by the. | `apps/web/test-e2e/live/signin.spec.ts` | pending M6-T13 |
| Browsers and exit (M6-T13) | Live-workflow.test.mjs is the model; live-workflow.test.mjs (run by test:tools) parses .github/workflows/descope-live-web.yml and. | `tools/m3-live/test/live-workflow.test.mjs`<br>`tools/m6-live/test/live-workflow.test.mjs` | pending M6-T13 |
| Browsers and exit (M6-T13) | The web origin (4173) differs from the API origin (8080) in every request log of the suite, and no request carries a cookie header. | `apps/web/test-e2e/m6/origins.spec.ts` | proved |
| Browsers and exit (M6-T13) | A mutation test (committed) that breaks one row of mapSignal and one rule of isSafeHref makes the suite fail in both places. | `apps/web/test-e2e/m6/mutation.spec.ts` | proved |
| Browsers and exit (M6-T13) | The `e2e-m6` job of the merge gate runs `make test-m6` with the browsers installed and cached and the pictures uploaded, and is listed in `ci-required`; a test reads it against the job of the third milestone. | `tools/ci/test/e2e-m6-job.test.mjs` | pending M6-T13 |
| Browsers and exit (M6-T13) | The web origin differs from the API origin in every request, and no request carries a cookie. | `apps/web/test-e2e/m6/origins.spec.ts` | proved |
| Browsers and exit (M6-T13) | A broken `mapSignal` row and a broken `isSafeHref` rule make the checks fail. | `apps/web/test-e2e/m6/mutation.spec.ts` | proved |
| Browsers and exit (M6-T13) | The server of the run requires the handshake: a run with `M6_REQUIRE_HANDSHAKE` unset fails with a plain line. | `apps/web/test-e2e/m6/handshake.spec.ts` | proved |
| Browsers and exit (M6-T13) | The run names the three browsers and every scenario, and removing a scenario from the list fails the run. | `apps/web/test-e2e/m6/exit.spec.ts` | proved |
| Browsers and exit (M6-T13) | With the browsers absent, `make test-m6` stops with "playwright browsers missing" before it starts anything. | `tools/ci/test/test-m6-target.test.mjs` | proved |
| Browsers and exit (M6-T13) | The `Makefile` does not change for the exit test: its target is in `mk/test-m6.mk`. | `tools/ci/test/test-m6-target.test.mjs` | proved |

## Build and hygiene

Each of these is checked by a job of the merge gate, on every pull request:

| Check | Where |
|---|---|
| `bun run typecheck` | job `static` |
| `bun run lint` | job `static` |
| `bun run test:coverage` (unit and web projects, coverage floors) | jobs `unit` and `coverage` |
| `bun run licence` | job `licence` |
| secrets scan | job `gitleaks` |
| workflows | job `workflow-policy` (actionlint, zizmor) |
| the browser specifications against the stack, in Chromium | job `e2e-web` |
| the same, in Firefox and WebKit | job `e2e-web-browsers` |

