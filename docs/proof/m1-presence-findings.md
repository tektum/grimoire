# Presence findings

Measured on `@hocuspocus/server` 4.8.0 by `packages/adapters/collab-hocuspocus/test/presence/presence.int.test.ts` (real sockets, three provider clients, hand-built awareness frames).

| Hook or mechanism | Used for | Result |
|---|---|---|
| `beforeHandleAwareness`: `states.delete(id)` | drop a state for a client id another connection owns, a second id, a wrong `user.id` | works |
| `beforeHandleAwareness`: `states.set(id, {...})` | fill or overwrite `user.id` from `context.userId` | works |
| `beforeHandleAwareness`: `removedClients.delete(id)` | drop a removal of another connection's client id (no fall back to throwing was needed) | works |
| `connection.sendStateless(...)` | tell the sender `{"grimoire":1,"kind":"refusal","code":"presence-violation"}` | works |
| `onDisconnect` | release the client id bindings | differs: the payload has no `connection`, only `socketId`, so bindings are keyed by socket id per document, not by `Connection` in a `WeakMap` |
| Hocuspocus's own removal on socket end | the other client sees the removal of a disconnected client's id | works |

The specification names a `WeakMap<Connection, Set<number>>`; with the payload above the extension keeps, per document, `Map<clientId, socketId>` and `Map<socketId, clientId>`. A connection owns one client id, the first it publishes in awareness; a third map, `bound`, records the client id of a socket's first DOCUMENT update, and that proof beats an awareness claim, which anyone can make first (known limit 9 of `m1-hocuspocus.md`).

## Office scenarios (100 users behind one address), before and after

| Scenario | Before (every upgrade counted) | After (only attempts that do not authenticate count) |
|---|---|---|
| 100 users open 3 pages each within a minute (300 sockets) | 250 of 300 locked out for 5 minutes | all 300 sync in about 3.3 s (`an office behind one address`) |
| 100 simultaneous reconnects after a restart | 90 refused | all 100 sync in about 1.1 s; the refused ones got `429` with `Retry-After: 2` and the provider retried |
| 500 cross-origin upgrades from a hostile page, then the user's own upgrade | the address was banned for 300 s | `403`s are not counted; the honest upgrade succeeds |

## Final rule

The Origin is checked first (a bad or missing Origin is `403` and is not counted). Each accepted upgrade is held until its first successful authentication; a socket that ends without authenticating (bad token, closed, or destroyed after the pre-authentication timeout, `GRIMOIRE_COLLAB_PREAUTH_TIMEOUT_SECONDS`, default 5 s) costs its address one point (a socket that could not be signed in because the verifier or the sign-in lookup was unavailable is counted as authenticated for this purpose and costs no point; a page that fails to load from the store after sign-in still costs one, because a socket counts as authenticated only when its document connects: a known limit during a page-store outage), 50 points per 60 s then a 300 s ban (`429` with `Retry-After` from the limiter), and at most 10 sockets per address may be unauthenticated at once (`429`, `Retry-After: 2`, not counted); the process-wide caps are 500 unauthenticated sockets and 64 MiB of queued pre-authentication bytes.

An attacker without a valid token can therefore, per address per minute, hold at most 10 sockets open before authenticating and make at most 50 failed attempts before a 5-minute ban: this is R4.19. The point is taken when the attempt fails, not refunded afterwards, so a burst of in-flight honest sockets never trips the limit. An attacker with a valid token is not limited by this rule (the connection and per-user caps still apply).

Awareness: honest states measured 312 bytes (cursor), 297 (long selection) and 520 (200-character name) as JSON; the cap is 4,096 bytes per state (`AWARENESS_STATE_MAX_BYTES`); an over-cap state is dropped and the sender gets `presence-violation`.

R4.19 counts attempts that do not authenticate; the guard destroys a socket that has not authenticated within the pre-authentication timeout (default 5 s, settable from 1 to 60 s).
