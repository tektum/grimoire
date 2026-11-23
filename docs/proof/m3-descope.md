# Descope findings note

Facts for sign-in (spec R8.3, R8.6, R8.18, R11.25, R11.35, R13.20). Nothing here comes from a sign-in: no Descope credential was used, no authenticated Descope call was made, no Descope setting was changed. The only network fetch was the project's public key set (documented public URL, no secret). The development project was not touched (R8.3).

Status values: `measured` = run locally with a generated key pair, or read in library source cited by file and line; `docs` = Descope documentation; `could not observe: <reason>` = needs the real project (to be filled when checked against a real project).

Versions checked from registry metadata and a scratch install: `@descope/node-sdk` 2.22.0 (MIT; depends on `@descope/core-js-sdk` 2.78.0, `jose` 5.2.2 pinned exactly, `tslib`), `jose` 6.2.18 (MIT, no dependencies), `@descope/web-js-sdk` 1.54.7, `@descope/web-component` 4.7.5, `@descope/react-sdk` 3.5.7. Source line references below are to the TypeScript embedded in the published source maps of those versions (`lib/index.ts` of node-sdk 2.22.0; `src/...` of web-js-sdk 1.54.7 and core-js-sdk 2.78.0).

## Decisions recorded here

- **Decision 94:** Descope's browser libraries are allowed. `@fingerprintjs/fingerprintjs-pro@3.11.6` (licence "SEE LICENSE IN LICENSE": FingerprintJS Terms of Service, outside the licence rule) is a recorded licence exception for the web client only. It is reached through `@descope/web-js-sdk` and `@descope/web-component` (and `@descope/react-sdk`). Its 6,446-byte loader is bundled but only active when `fpKey` is configured (`src/enhancers/withFingerprint/index.ts`).
- **Decision 96:** the web client uses `@descope/web-component` with `@descope/web-js-sdk`.
- **Server (decision 152):** the proof was built with `jose` alone. Since decision 152 the adapter uses the official Descope Node SDK, with Grimoire's own token policy and failure mapping on top and a guarded `fetch`; the web client uses the web SDK. A finding of the proof stays true and is kept here: the Node SDK cannot separate a token with an unknown key id from an unreachable key service by its error alone (both read "failed to fetch matching key"; a forged token with a known key id has its own error text) (see the section on valid, expired and forged tokens), which is why the adapter classifies the SDK's error shapes.

### Claims in a session token

status: docs

- Always present: `sub` (Descope user id), `iss` (the project id, or a URL when an OIDC-style JWT template is used), `iat`, `exp`, `drn` (`DS` for Descope-managed sessions), `amr`. Context-dependent: `rexp`, `dct`, `tenants` (map of tenant id to `roles`/`permissions`), top-level `roles`/`permissions`, `tu: true` for test users. `aud` only via a template or custom claims action. Source: docs.descope.com/management/token.
- **Email and name are not in the token by default.** A custom claim can carry them only through a JWT template or the Custom Claims action (limits: 100 keys, key 60 characters, value 500 characters). That `{{user.email}}` and name are valid template values is not shown in the docs (only `user.userId` and `user.customAttributes.*`): could not observe.
- A documentation example token has `exp - iat = 600` seconds.
- Node SDK reads: `sub`, `exp` from the verified payload; roles helpers read `roles`, `permissions`, `tenants[tid]` (`lib/index.ts`, `validateTenantRoles`, about line 493 onward).
- Real token from the dev project: could not observe (no sign-in was made).

### Lifetimes of session and refresh tokens

status: docs

- Refresh token: "typically valid for 1 month"; maximum 6 months (3 years on Enterprise). Session token: at least 3 minutes and never longer than the refresh token (docs.descope.com/management/project-settings, /security-best-practices/refresh-token-storage).
- The configured and default values of the dev project are not stated in the documentation and need the console: could not observe. Plan for 10 minutes (documentation example) until the live target records the real value.

### Refresh and rotation

status: measured

- Server side, read in `lib/index.ts` (node-sdk 2.22.0): `refreshSession(refreshToken)` validates the refresh JWT, calls `sdk.refresh` (`POST /v1/auth/refresh`, `core-js-sdk src/constants/apiPaths.ts:101`), then validates the returned session JWT; `validateAndRefreshSession` validates the session token and on any failure refreshes. Grimoire's server never holds a refresh token and does not use these.
- Browser side, `web-js-sdk src/constants.ts`: `REFRESH_THRESHOLD = 20 * 1000`; `src/enhancers/withAutoRefresh/index.ts` refreshes by timer 20 s before `exp` and on `visibilitychange` when the tab becomes visible past expiry (about lines 67 to 78). A hidden tab can therefore hold an expired session token; the WebSocket `token()` function must refresh before returning.
- Refresh token rotation (a new refresh token on each refresh) is a project setting and a Pro tier feature per docs.descope.com/management/project-settings; whether the dev project enables it: could not observe.

### Valid, expired, forged, unknown-key, malformed and unreachable key service

status: measured

Method: local RSA key pair (`jose` `generateKeyPair('RS256')`), a local HTTP server serving `{keys:[jwk]}` at `/v2/keys/<project id>`, the node SDK pointed at it with `baseUrl`, and `jose` `createRemoteJWKSet` against the same URL. Same tokens for both.

| Input | `@descope/node-sdk` 2.22.0 `validateSession` | `jose` 6.2.18 `jwtVerify` |
|---|---|---|
| valid | ok, `iss` normalised to the project id | ok |
| expired | generic `Error`, text "JWTExpired" | `JWTExpired` (`ERR_JWT_EXPIRED`) |
| wrong issuer | generic `Error`, text "unexpected iss claim value" | `JWTClaimValidationFailed` |
| forged (known kid, other key) | generic `Error`, text "JWSSignatureVerificationFailed" | `JWSSignatureVerificationFailed` |
| unknown kid, key server up | generic `Error`, text **"failed to fetch matching key"** | `JWKSNoMatchingKey` |
| key server down, cold cache | generic `Error`, text **"failed to fetch matching key"** (identical to the line above) | `TypeError: fetch failed` |
| key server HTTP 500 | same text | `JOSEError` `ERR_JOSE_GENERIC` |
| malformed | generic `Error`, text "JWSInvalid" | `JWSInvalid` |
| `alg: none` | generic `Error`, text "header.kid must not be empty" | `JOSEAlgNotAllowed` |

- Source for the SDK shape: `lib/index.ts` `validateSession` catches everything and throws `Error("session validation failed. Error: " + error)` (about line 301 to 316); `getKey` throws "failed to fetch matching key" when the key is missing after a swallowed fetch failure (about line 238 to 262). So the split R4.9 asks for can only be done by matching text, and an unknown kid is indistinguishable from an outage.
- Warm cache with the key server down: both libraries still validate (measured).
- Key cache: node SDK refreshes after 10 minutes, refuses cached keys after 60 minutes, 30 s retry cooldown (`lib/index.ts` of `@descope/node-sdk` 2.22.0: `KEYS_TTL_MS`, `KEYS_MAX_AGE_MS`, `UNKNOWN_KID_COOLDOWN_MS`). `jose`: 600 s cache, 30 s cooldown, **no stale serving**: with a stale cache and the server down, verification fails with `fetch failed` (measured). Rotation: a token with a new kid sent within the 30 s cooldown after the last fetch gets `JWKSNoMatchingKey`, then succeeds after the cooldown (measured).
- No network call per request: 2,000 validations of a valid token gave 0 key fetches, 45 microseconds each (SDK) and 47 (jose).
- Adapter mapping measured with the proof's own `jose` harness of 36 lines (before the Node SDK was adopted, decision 152): valid gives `ok`; expired, unknown kid, garbage give `invalid-token`; cold cache with the key server down gives `service-unavailable`; warm cache with it down gives `ok`. Rule used: not a `JOSEError`, or code `ERR_JOSE_GENERIC`, `ERR_JWKS_TIMEOUT`, `ERR_JWKS_INVALID` means `service-unavailable`; every other jose error means `invalid-token`. The shipped adapter does not use that rule: `classifySdkError` in `packages/adapters/auth-descope/src/index.ts` sorts the SDK's error shapes into `token` (a `jose` error code starting `ERR_J`, or a token without a key id), `no-key` ("failed to fetch matching key", which is the same for an unknown key id and for an outage) and `unrecognised` (refused and logged); the adapter's own key-fetch flag then chooses `invalid-token` (the last key fetch worked) or `service-unavailable` (it failed). The contract tests drive the real SDK through each case.
- Real Descope key service behaviour (rate limit on the key URL, outage): could not observe; the mapping for the real service needs a real project to check.

### Where the browser SDK keeps tokens, and what it needs from the page origin

status: measured

- Read in `@descope/web-js-sdk` 1.54.7 `src/enhancers/withPersistTokens/constants.ts` and `helpers.ts`: by default both tokens are stored in `localStorage` under the keys `DS` (session token) and `DSR` (refresh token), prefixed by the `storagePrefix` option if set; also `DSI` (id token), `DTD`, `DKD` (device tokens, kept after logout), `DSRCN` (refresh cookie name).
- Options that change it: `persistTokens`, `sessionTokenViaCookie`, `refreshTokenViaCookie` (cookies written by `js-cookie`, so **not** HttpOnly; default `SameSite=Strict`, `Secure` true, a warning and no cookie on non-HTTPS pages), `storagePrefix`, `refreshCookieName`. `getRefreshToken` reads the cookie first, then `localStorage`; `clearTokens` removes all of them.
- Consequence for R11.35: with the default, a script injected into the page reads a long-lived refresh token from `localStorage`; R12.9 and R12.10 (content-security-policy and escaping) are the only defence. Recorded as a risk.
- HttpOnly cookies set by Descope itself require the project setting "manage in cookies" plus a custom domain (docs.descope.com/security-best-practices/session-token-storage, /refresh-token-storage; status docs). They cannot be read by script, so they cannot supply the WebSocket token, and they do not fit wrappers (decision 74).
- Page origin requirements: the SDK needs a secure context only for cookie mode; for `localStorage` mode none was found in source. Whether the dev project's approved-domains setting blocks `http://localhost` origins: could not observe. Behaviour inside Tauri and Capacitor webviews: could not observe.

### Origins and content-security-policy entries for the Flows UI

status: docs

From docs.descope.com/security-best-practices/content-security-policy (no custom domain): `connect-src 'self' api.descope.com static.descope.com`; `script-src 'self' descopecdn.com static.descope.com cdn.jsdelivr.net` (plus a nonce through the component's `nonce` property); `style-src 'self' 'unsafe-inline' fonts.googleapis.com`; `font-src fonts.gstatic.com descopecdn.com data:`; `img-src 'self' static.descope.com data:`. With a custom domain the CNAME host replaces `api.descope.com` and `static.descope.com` in `connect-src` and `img-src`. Host strings found in a production bundle of `@descope/react-sdk` (built in a scratch project): `static.descope.com/pages`, `static2.descope.com/pages`, `api.descope.com`, `descopecdn.com/npm/oidc-client-ts`, `cdn.jsdelivr.net/npm/oidc-client-ts` (lazy OIDC library), `accounts.google.com/gsi/client` (Google One Tap): these host names are `measured` in the bundle, but whether the Flows screens actually load each of them at run time: could not observe. Bundle weights (esbuild, minified): web-js-sdk 57 KB raw / 19 KB gzip; web-component 201 / 61 KB; React plus the Descope component 354 / 111 KB (React alone 142 / 46 KB).

### Whether email and name need a second call

status: docs

- **Source when the token carries no profile: `profile(userId)`** (R8.18; port method `AuthVerifier.profile?`). Reason: the default token has no email or name (see the claims section), and the template route is not confirmed. The server obtains email, name and `verifiedEmail` with a management call (`management.user.loadByUserId`, needs a management key, `/v1/mgmt/user/*` is limited to 1,000 requests per 60 seconds per project, so it is used once at first sign-in, not per request). Signed token claims, when they carry a profile, come first: the adapter attaches the profile from the claims whenever the verified token carries them, the provisioner uses it before any lookup, and `profile(userId)` is called only for an identity that is not known yet and whose token has no profile (`packages/core/src/users/provisioner.ts`, "Claims come first"). A returning user is re-checked against the allowed domains on every sign-in when the claims carry a profile (decision 151).
- `GET /v1/auth/me` (`sdk.me(refreshToken)`, `core-js-sdk src/sdk/index.ts` and `src/sdk/types.ts` `UserResponse`: `loginIds`, `userId`, `verifiedEmail`, name, email) works but needs the **refresh token**, which the server does not hold. The client must not send a profile for the server to trust.
- Whether the real `loadByUserId` returns what the types promise: could not observe (needs a management key; not used).

### Revocation latency for a disable, a sign-out and a role change

status: docs

- Sessions end on logout, refresh expiry, inactivity timeout, or server-side revocation "for example an admin disables the user or you call the logout API" (docs.descope.com/sessions). Claim values such as roles update "when the session is refreshed" (docs.descope.com/management/token). A server that validates only locally (jose, no network) sees none of it until the session token's `exp`; the documentation names a "5 to 10 minute" window (docs.descope.com/sessions/introspection, which describes introspection for federated and inbound app tokens only; for project session tokens: could not observe).
- Therefore: a disable or sign-out in Descope reaches the server within one session-token lifetime (minimum 3 minutes) once the refresh is refused; a role change in Descope is irrelevant to Grimoire authorisation because roles live in PostgreSQL (R8.16). Grimoire-side changes (suspend, collection removal) are caught by the one-minute re-check (R4.48).
- Options and costs (docs): management `loadByUserId` per user per minute exhausts the 1,000 per 60 seconds limit at 1,000 users (not recommended); one `POST /v2/mgmt/user/search` with `fromModifiedTime` per minute (limit 200 per 60 seconds); audit webhooks ("not real-time", throttled, public endpoint needed); management "logout all devices" and JWK "Rotate and Revoke" for emergencies. No revocation list for session tokens is documented.
- Hocuspocus 4.8 mechanism for live connections, `measured` locally with a generated key pair: a server calls `connection.requestToken()`, the provider's `token()` function is called and its result reaches the `onTokenSync` hook; a hook that throws closes that document connection; assigning `connection.readOnly` takes effect on the next update (`@hocuspocus/server` `src/MessageReceiver.ts` lines 176 to 178 and 234, `src/Connection.ts` line 197).
- Actual latency of a disable in the dev project: could not observe (needs the real project and a management key).

### Key-set URL, rotation and cache rules

status: measured

- URLs: `GET <base>/v2/keys/<project id>` (node SDK `lib/index.ts` line 116) and `GET <base>/<project id>/.well-known/jwks.json` (documented in docs.descope.com/sessions/validation/jwt-authorizers/python-fastapi-jwt-authorizer). Both fetched once, unauthenticated, for the dev project id: HTTP 200, identical body, `cache-control: no-store, no-cache`, 72 ms. One key: `kty RSA`, 2048 bits, `alg RS256`, `use sig`, `kid` starting `SK`, and `"crv": null`, which `jose` imports without error (`importJWK`, `createLocalJWKSet`). Key material is not reproduced here.
- Base URL by region: `region = projectId.slice(1, -27)` (`core-js-sdk src/httpClient/urlBuilder.ts` line 19); an empty region (28-character id, as the dev project) gives `https://api.descope.com`, otherwise `https://api.<region>.descope.com`; a custom domain needs an explicit base URL.
- Rotation (docs.descope.com/additional-security-features-in-descope/jwk-rotation, status docs): daily by default, keys more than 12 rotations old are invalidated, "Rotate and Revoke" forces every user to sign in again. The dev project showed one key at fetch time; the rotation schedule of the dev project: could not observe.
- Operator note: the SDK does not refetch the key set within 30 s of the last successful fetch. After the provider rotates keys, tokens signed by the new key may be refused (`invalid-token`) for up to 30 seconds on a server that fetched keys just before; after that they are accepted and tokens of the removed key are refused. Pinned by the contract test "known property: a newly published key is picked up within the SDK's 30 s cooldown"; the end-to-end check runs in `make test-m3` (scenario `key-server-outage`: restart only the key server, wait up to 90 s for a token of the new key to sign in, and assert that a token of the old key is refused `invalid-token`); only the fixed 35 s wait and the figure "about 30 ms" were measured by hand.
- Cache rules: see the section on valid, expired and forged tokens. The proof used `jose` `createRemoteJWKSet` with `cacheMaxAge` 600000, `cooldownDuration` 30000 and `timeoutDuration` 3000, which does not read `cache-control`; the SDK keeps the same timings (10 minutes, 30 seconds, one hour at most).
- Hono's `jwk` middleware with `jwks_uri` fetches the key set on every request (20 requests gave 20 fetches, measured) and is not used.
