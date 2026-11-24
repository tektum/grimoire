# The web client

`apps/web` is the browser client: React 19, Vite, no server rendering. The build is static files in `apps/web/dist`, with relative asset paths and no service worker, so any static host can serve it.

## Run it

| Task | Command (from the repository root) |
|---|---|
| Develop with reload (port 5173) | `bun run --cwd apps/web dev` |
| Build | `bun run --cwd apps/web build` |
| Check the build | `bun run --cwd apps/web check:build` |
| Serve the build (port 4173, deep links work) | `bun run --cwd apps/web serve` |
| Unit tests | `bun run test` (the `web` project runs under happy-dom) |

`check:build` fails when a chunk the entry document loads contains the sign-in libraries, when any chunk holds the development sign-in marker or the design sample marker, when an asset path is absolute, or when `config.json` is missing.

## Configuration

The one build-time setting is `config.json` next to `index.html`: `{ "apiUrl": "https://…" }`, with an optional `hiddenDisconnectMs` (how long a hidden tab stays connected; default 600000). The client reads it before anything else. Everything else comes from `GET /v1/config`.

The documents set `<base href="/">`, so the app is served from the root of its origin and a refresh on a deep link such as `/p/some-page-ab12cd/history` loads the scripts and `config.json` from the root.

## Build modes

`production` (default), `e2e` and `development`. The last two define `__GRIMOIRE_DEV_SIGNIN__` as true, which turns on the development sign-in and the `/design-sample` page; in a production build both are removed.

## Headers

`headers/headers.template` holds the response headers and the two content security policies of the client. `scripts/render-headers.mjs` fills in a deployment's origins and writes `headers.json` beside the build (the lines each of the two documents is served with; there is no `_headers` file for a static host); see `docs/web-security.md`. `Referrer-Policy: no-referrer` appears once, so page addresses never leave the browser. `scripts/serve.mjs` applies the plain headers when it serves the build for tests, and the rendered ones when `GRIMOIRE_WEB_HEADERS_DIR` names the renderer's output.

## Source layout

| Folder | Holds |
|---|---|
| `src/app` | the shell, the route table (`routes.ts`) and the router |
| `src/api` | the one API client, its middleware (refresh, retries, notices), `messages.ts` (every user-facing error text) and the query helpers |
| `src/config` | the `config.json` loader |
| `src/storage` | `ClientStorage`, the only place the client keeps its own preferences (keys start with `grimoire.`) |
| `src/logging` | `log()`, which takes scalar fields only |
| `src/ui` | tokens, global styles, the collaborator palette and the primitives (Radix, cmdk, sonner) |
| `src/screens` | one folder per screen |

Lint enforces the boundaries: browser storage only in `src/storage` and `src/auth`; `fetch` only in `src/api`, `src/auth`, `src/gate` and `src/config`; `console` only in `src/logging`; no import of an adapter or the server.

## Look and feel

Tokens are CSS custom properties in `src/ui/tokens.css`: `--paper`, `--ink`, `--accent`, `--muted`, `--border`, `--focus`, the fonts, spacing and radii. Light is the default; dark follows the system or `data-theme="dark"` on `<html>`. Fonts are system stacks. The eight collaborator colours are fixed, and each name label is black or white by luminance, at least 4.5:1 against its colour. `prefers-reduced-motion: reduce` removes transitions and animations. The values are proposals until the design is settled: changing them is a change to `tokens.css`.

## The editing menus, the soft lock and the help page

- **Menus** (`src/editor/menus`): the slash menu (`/` at the start of a paragraph), the bubble over a selection (inline formatting and the link editor; Escape puts the bar away, the selection stays) and the block handle beside the block the pointer is over. The slash menu and the handle share one list of block kinds (`blocks.ts`). The link editor checks an address with `isSafeUrl` of `editor-schema` and says "This kind of link isn't allowed" for the rest.
- **Soft lock** (`src/editor/lock`, R3.14 to R3.17): each editor publishes the id of the block its cursor is in (`blockId` on the awareness: the Yjs element's `client:clock`). Turning a block into a list, a quote or a code block is refused while another person's cursor is in it, with "<name> is editing this block" and a "Why?" that opens the help. A heading level, a divider or a table is not refused.
- **Help page**: `/help` (screen `help`, signed in) is not in the contracts' route table; it is added here because the limit text (R3.26, R3.27) has to be on a help page. Its words are those of the "Why?".
- **Test builds** (the end-to-end build and development, never production) put the open page's shared document on `window.__grimoireDoc` and its awareness on `window.__grimoireAwareness`, so that specifications can check what an editor did to the document and who is in which block. `test/unit/test-hook.test.ts` checks that no production chunk has them.

## Connection signals observed from the real server

The client maps what the collab server says to what the page does in `src/editor/core/map-signal.ts`, a refusal by its reason, a close by its code (a few close reasons are read first: `access-changed`, `session-expired`, `stale-epoch`, `rate-limited`). The table below is what the real server answered to the browser's own socket, recorded by `test-e2e/editor/connection-signals.spec.ts` in the `Web browser tests` job (the spec prints the line `observed-signals`; this is its output from a passing run).

| Case | Refusal reason | Close code | Close reason |
|---|---|---|---|
| a token the server does not accept | `invalid-token` | 4401 | `invalid-token` |
| a page that does not exist | `not-found` | 4404 | `not-found` |
| a document name that is not a page id | `bad-document-name` | 4400 | `bad-document-name` |
| a page that already has as many connections as the server allows (cap of one, `page-full.spec`) | `page-full` | 4413 | `page-full` |
| a bare session token, with the handshake required (`require-handshake.spec`) | `client-too-old` | 4426 | `client-too-old` |
| a person whose access to the page was taken away (`access-changes.spec`): every denial of a page looks the same | `not-found` | 4404 | `not-found` |
| a person who is suspended (`access-changes.spec`) | `forbidden` | 4403 | `forbidden` |

In each the close reason repeats the refusal reason. A server that requires the handshake answers a token that is not a handshake token with `client-too-old`, not `invalid-token`. Every reason has a row in the mapping, and each spec checks that the socket is closed, that the close reason equals the refusal reason, and that the close is handled exactly as the refusal is (same behaviour and text).

`forbidden` is sent only for a person who is missing or suspended; a page the person may not read is `not-found`. A suspended person is signed out by the API ("Your account is suspended") before the editor shows anything. Lowering write to read leaves the page as it is (no reset, the same state epoch): the editor goes read-only and keeps its text.

`session-expired` is not in this table: a development token lives one hour, longer than a spec can wait, so the client's answer to it is driven by a scripted server (`signal-rows.spec.ts`) and the connection manager's unit tests.

## The status line: Saved, Saving, Offline

The line under the page title (`src/status`) is the page's one polite live region (`role="status"`, `aria-live="polite"`); it never takes the focus. It says, most important first:

1. a message of the signal table (a refusal, a limit, the offline text);
2. `Connecting…` until the page has synced;
3. once synced, `Saving` while the server has not acknowledged changes made in this tab, and `Saved` when it has. A reader has nothing to save and sees `Live`.

How unsynced changes are detected: the Hocuspocus provider counts them (`unsyncedChanges`: it goes up with each local update of the shared document and down as the server acknowledges each one), and emits an `unsyncedChanges` event with the number. The provider adapter (`src/editor/core/real-provider.ts`) passes it on as an `unsynced` event, the connection manager keeps it as `unsynced` in its state (0 for each new document), and the line says Saving while it is above 0. `Saving` shows at once; `Saved` waits for 600 ms of nothing waiting, so typing does not make the line, and a screen reader, flip on every keystroke. The offline text still comes from the connection manager: no connection for more than 10 seconds.

## Images in a page

The image node of the editor (`src/editor/attachments`) shows only what the application stored. A source of the shape `attachments/<uuid>/<name>` (the `markdownPath` the server returns when a file is uploaded) is shown through a signed link: the images of a page that load together are asked for in one `POST /v1/attachments/urls` (up to 50 ids), a link that fails to load, or is about to expire, is replaced once without a reload, and a second failure straight after says "Image couldn't be loaded" instead of looping. Any other source (a web address, also one with no scheme such as `//host/p.png`, or a relative path such as `./x.png`) is never given to the browser: a placeholder reads "External image not loaded: <host>" (the host is a link by the one link rule), so the editor makes no request for it. A `data:` address is already dropped by the shared schema when the Markdown is read, leaving the image's alt text.

## Uploading files

A file pasted into the editor or dropped on it (`src/editor/attachments`) follows the file store's sequence: `POST /v1/attachments` (the server says where to send the bytes and with which headers), a `PUT` of the bytes to that address with exactly those headers and no credentials, then `POST /v1/attachments/{id}/complete`. All files of one paste or drop go in parallel; "Uploading…" marks the place until they are done. An image is put into the page as `![name](attachments/<id>/<name>)` and any other file as a link with its name to the same kind of path (the server returns the cleaned `markdownPath`; the page keeps it as it is). A refused file leaves nothing in the document and is told once, in plain words: "That file type isn't allowed", "That file is too large", "Too many uploads at once. Wait a moment." (the server allows ten unfinished uploads for each person, and an eleventh is refused), "The upload didn't finish. Try again". The calls use a copy of the session's API client with its toasts off, so a refusal is told in these words and not twice; its token, refresh and retries are the client's.

A click on a link to an uploaded file asks for a signed link at that moment (`GET /v1/attachments/{id}`) and opens it in another tab; the relative path in the Markdown is never requested.
