# Web client security

What the browser is told about the web client, what it still trusts, and where each rule is enforced. The rules come from R12.9, R12.10 and R12.27 of the specification and the decisions it cites.

## Response headers

`apps/web/scripts/render-headers.mjs` renders `apps/web/headers/headers.template` for a deployment: `node scripts/render-headers.mjs --api-origin <https origin> --collab-origin <wss origin> --store-origin <https origin>`. It writes three files beside the build. `headers` has the format of a `_headers` file, with one block for each built document. `headers.json` holds the same lines for a server that sets them itself. `redirects` sends `/login` to the sign-in document and every other path to the app. The origins are checked: a missing one, a path, or the wrong scheme (the collaboration origin is `wss:` or `ws:`, written out) stops the command with one plain line.

Every document gets `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and a `Content-Security-Policy` that starts from `default-src 'none'`, with `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'` and `form-action 'self'`. No policy allows `'unsafe-inline'` or `'unsafe-eval'` for scripts.

| Directive | App (`index.html`) | Sign-in screen (`login.html`) |
|---|---|---|
| `script-src` | `'self'` | `'self'` and the sign-in origins below |
| `connect-src` | `'self'`, the API, the collaboration socket, the file store, `https://api.descope.com` | the same, and the sign-in origins below |
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

`frame-ancestors` cannot be set in a `<meta>` element, so the client must be served with real response headers. A static host that cannot set headers cannot run it. A host that applies a `_headers` file by the requested path, not by the document it serves, would give the app's deep links no policy: set the headers from `headers.json` instead. `apps/web/scripts/serve.mjs` does that: with `GRIMOIRE_WEB_HEADERS_DIR` set to the output of the renderer it gives `login.html` and every other path the lines of their own block.

## Rendering rules

1. **Links.** A link in the editor, the read-only view, history, search and the import report has only an address that is relative (`/`, `./`, `../`, `#`, `?`) or has a scheme of the one allow-list `isSafeUrl(value, 'link')` of `packages/editor-schema`: `http`, `https`, `mailto`, `tel`, `sms`, `xmpp`, `irc`, `ircs`, `ftp`, `ftps`, `matrix` and `geo` (the list at `packages/editor-schema/src/index.ts`, `SCHEMES.link`, kept because real Markdown uses them and the converter keeps them). `javascript:`, `file:`, `vbscript:`, `data:` and `blob:` are refused in every spelling a browser would read as one. `isSafeHref` in `apps/web/src/safety/index.ts` is a thin wrapper of that function, so the client and the saved Markdown cannot disagree.
2. **Raw HTML in Markdown** is shown as inert text in a non-editable block with an "Edit source" button. Nothing in it is parsed, so no script runs and no request is made.
3. **Pasted HTML** is to be sanitised with DOMPurify, which is licensed under MPL-2.0 or Apache-2.0: we take the Apache-2.0 option. This is not built yet: it is the next change of this task.
4. **Images** are shown only when they are uploaded ones (a relative path, or a signed address of the file store). The policy's `img-src` enforces the same; the editor's placeholder for anything else comes with the attachment work.
5. **Clickjacking and referrer:** `frame-ancestors 'none'`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`, from the headers above.

## Not yet checked

The policy has not been run against the built app in a browser: whether `style-src 'self'` shows violations (a menu library may write style attributes), and whether the app signs in and opens a page with no violation report. Those checks need the Compose stack and a browser job in CI. Any violation found is recorded here, and `'unsafe-inline'` is added to the app's `style-src` only, if that is what it takes.
