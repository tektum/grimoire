# Web client security

What the browser is told about the web client, what it still trusts, and where each rule is enforced. The rules come from R12.9, R12.10 and R12.27 of the specification and the decisions it cites.

## Response headers

`apps/web/scripts/render-headers.mjs` renders `apps/web/headers/headers.template` for a deployment: `node scripts/render-headers.mjs --api-origin <origin> --collab-origin <origin> --store-origin <origin>`. It writes `headers.json` beside the build: for each of the two built documents, `/index.html` (the app) and `/login.html` (the sign-in screen), the header lines it is served with. The origins are checked strictly, because they go into a policy: each must be exactly an origin. It uses `https:` (the collaboration socket `wss:`, written out), or the plain scheme (`http:`, `ws:`) for `localhost`, `127.0.0.1` or `[::1]` only, in local development; an explicit default port is accepted; a user, path, query, fragment, space or semicolon is refused. `--descope-origin` is the identity provider's API (default `https://api.descope.com`; a regional project uses its own). `--fingerprint-connect` takes the vendor's connect hosts, each checked the same way. A missing or malformed value stops the command with one plain line.

The server of the product does the same at start, from its own settings (see Hosting requirement). There is no `_headers` file for a static host: such a host matches its rules against the requested path, not the document it serves, so it cannot give `/login` the sign-in policy and every other route the app's without sending both policies to `/login`.

Every document gets `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and a `Content-Security-Policy` that starts from `default-src 'none'`, with `frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'` and `form-action 'self'`. `base-uri` is `'self'` and not `'none'` because both documents have `<base href="/">`, which a deep link such as `/p/page-x` needs to load its assets from `/assets/`. No policy allows `'unsafe-inline'` or `'unsafe-eval'` for scripts.

| Directive | App (`index.html`) | Sign-in screen (`login.html`) |
|---|---|---|
| `script-src` | `'self'` | `'self'` and the sign-in origins below |
| `connect-src` | `'self'`, the API, the collaboration socket, the file store, the identity provider's API | the same, and the sign-in origins below |
| `img-src` | `'self'` and the file store | the same, `https://static.descope.com` and `data:` |
| `style-src` | `'self'` | `'self'`, `'unsafe-inline'` and `https://fonts.googleapis.com` |
| `font-src` | `'self'` | `'self'`, `https://fonts.gstatic.com`, `https://descopecdn.com` and `data:` |
| `frame-src` | none | `https://accounts.google.com` |

The app's policy has no third-party origin at all. The file store is in `connect-src` because the browser sends uploads straight to it (R12.10), and in `img-src` because only images uploaded to the tool are shown (decision 103).

### Third-party scripts at sign-in

The identity provider's sign-in component loads code and assets from these origins, so the sign-in document allows them (decision 94): `descopecdn.com`, `static.descope.com`, `static2.descope.com`, `cdn.jsdelivr.net`, `fpnpmcdn.net` (the fingerprinting library the sign-in libraries pull in), `accounts.google.com`, `fonts.googleapis.com` and `fonts.gstatic.com`. This is a consequence an owner should know: the sign-in page runs scripts from those hosts, and `cdn.jsdelivr.net` serves any package on npm, so a bug that lets someone inject HTML into the sign-in document could load a script of their choice from it. The sign-in document is separate so that the app does not carry this risk. The vendor's connect hosts for fingerprinting are not listed yet (`{{FINGERPRINT_CONNECT}}` is empty): the manual sign-in check lists them, and until then the sign-in screen may log policy violations.

`--signin=app-wide` is the fallback: one policy with the whole list for both documents. It puts `data:` in `img-src` of the whole app, which goes against decision 103 for the main document. The default mode does not.

### What the session is worth to a script

The sign-in library keeps the session token (`DS`) and the refresh token (`DSR`) in `localStorage`, which every script of the origin can read. A script that runs in the app can therefore take the refresh token and use it elsewhere. That is why the app's policy allows no script but its own, and why the rules below exist: the policy is the second defence, not the first.

### Hosting requirement

`frame-ancestors` cannot be set in a `<meta>` element, so the client must be served with real response headers, and each document with the lines of its own block of `headers.json`. Two servers do that. The product's server serves the built client when `GRIMOIRE_WEB_ROOT` names the folder that holds it (the image has it at `/app/web`): it needs `GRIMOIRE_PUBLIC_API_URL`, `GRIMOIRE_PUBLIC_COLLAB_URL` and the file store settings, renders the headers at start (the identity provider's address comes from `GRIMOIRE_DESCOPE_BASE_URL`, default `https://api.descope.com`), serves `/config.json` from the public API address, `/login` as the sign-in document and any other extension-less path as the app, and never answers the API's paths. A missing file is a 404, never the app, and the defaults that give the API its security headers are not laid over the documents. `apps/web/scripts/serve.mjs`, for tests, does it for documents with `GRIMOIRE_WEB_HEADERS_DIR` set to the renderer's output, and refuses a `headers.json` that lacks a document or its policy. A static host that sets headers by requested path cannot run the client.

## Rendering rules

1. **Links.** A link in the editor, the read-only view, history, search and the import report has only an address that is relative (`/`, `./`, `../`, `#`, `?`) or has a scheme of the one allow-list `isSafeUrl(value, 'link')` of `packages/editor-schema`: `http`, `https`, `mailto`, `tel`, `sms`, `xmpp`, `irc`, `ircs`, `ftp`, `ftps`, `matrix` and `geo` (the list at `packages/editor-schema/src/index.ts`, `SCHEMES.link`, kept because real Markdown uses them and the converter keeps them). `javascript:`, `file:`, `vbscript:`, `data:` and `blob:` are refused in every spelling a browser would read as one. `isSafeHref` in `apps/web/src/safety/index.ts` is a thin wrapper of that function, so the client and the saved Markdown cannot disagree.
2. **Raw HTML in Markdown** is shown as inert text in a non-editable block with an "Edit source" button. Nothing in it is parsed, so no script runs and no request is made.
3. **Pasted HTML** (and HTML dropped on the page) goes through DOMPurify before the editor reads it (`apps/web/src/safety/paste.ts`); DOMPurify is licensed under MPL-2.0 or Apache-2.0, and we take the Apache-2.0 option. The allow-list is the structural and inline text elements of a page (paragraphs, headings, quotes, code, emphasis, lists, tables, `a`, `img`); no `script`, `iframe`, `form`, `style`, `object`, `embed`, `svg` or `math` element, no event handler, no `style` attribute, no class, no `data-` or `aria-` attribute (but the language of a code block), and an address stays only if the rule for it allows it: a link's by rule 1 (`isSafeHref`), an image's by `isSafeUrl(value, 'image')`. An element that goes leaves its words. The result is then read by the schema, which drops what is left of active content by itself; the sanitising is in front of it, not instead of it. The editor's own plugins are not changed: a plugin of the clipboard that cleans word-processor markup sees the sanitised text.
4. **Images** are shown only when they are uploaded ones (a relative path, or a signed address of the file store). The policy's `img-src` enforces the same; the editor's placeholder for anything else comes with the attachment work.
5. **Clickjacking and referrer:** `frame-ancestors 'none'`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`, from the headers above.

## Not yet checked

The policy has not been run against the built app in a browser: whether `style-src 'self'` shows violations (a menu library may write style attributes), and whether the app signs in and opens a page with no violation report. Those checks need the Compose stack and a browser job in CI. Any violation found is recorded here, and `'unsafe-inline'` is added to the app's `style-src` only, if that is what it takes.
