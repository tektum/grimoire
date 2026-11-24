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

`headers/headers.template` lists the response headers in the format of a `_headers` file, for a static host that reads a `_headers` file. `Referrer-Policy: no-referrer` appears once, so page addresses never leave the browser. `scripts/serve.mjs` applies the same file when it serves the build for tests.

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

## Connection signals observed from the real server

The client maps what the collab server says to what the page does in `src/editor/core/map-signal.ts`, a refusal by its reason, a close by its code (a few close reasons are read first: `access-changed`, `session-expired`, `stale-epoch`, `rate-limited`). The table below is what the real server answered to the browser's own socket, recorded by `test-e2e/editor/connection-signals.spec.ts` in the `Web browser tests` job (the spec prints the line `observed-signals`; this is its output from a passing run).

| Case | Refusal reason | Close code | Close reason |
|---|---|---|---|
| a token the server does not accept | `invalid-token` | 4401 | `invalid-token` |
| a page that does not exist | `not-found` | 4404 | `not-found` |
| a document name that is not a page id | `bad-document-name` | 4400 | `bad-document-name` |
| a page that already has as many connections as the server allows (cap of one, `page-full.spec`) | `page-full` | 4413 | `page-full` |
| a bare session token, with the handshake required (`require-handshake.spec`) | `client-too-old` | 4426 | `client-too-old` |

In each the close reason repeats the refusal reason. A server that requires the handshake answers a token that is not a handshake token with `client-too-old`, not `invalid-token`. Every reason has a row in the mapping, and each spec checks that the socket is closed, that the close reason equals the refusal reason, and that the close is handled exactly as the refusal is (same behaviour and text).

The other signals (`access-changed`, `session-expired`) are not in this table. `session-expired` cannot occur on the test stack (the development sign-in has no expiry), so the client's answer to it is driven by a scripted server (`signal-rows.spec.ts`) and the connection manager's unit tests.
