# Known limitations of the live-editing service

Each limit below is a behaviour that exists today, with where it comes from, what it costs and what bounds it. The numbers are the defaults of the settings named; none of them is a guarantee beyond what is stated.

## Sign-in

- **A newly published signing key can be refused for up to 30 seconds.** The provider's SDK does not refetch the key set within 30 seconds of the last successful fetch (10-minute cache, no key older than one hour). After the provider rotates keys, a token signed by the new key can be answered `invalid-token` on a server that fetched keys just before; after the cooldown it is accepted, and tokens of the removed key are refused. Bounded by the cooldown; the exit test `key-server-outage` pins the recovery. See `docs/proof/m3-descope.md`, Q9.
- **During a key-service outage a warm cache keeps working for up to one hour; a cold cache answers service unavailable.** The 24-hour token lifetime cap and the one-hour key age are both enforced.

## Connections

- **At most 10 sockets per address may be unauthenticated at once** (`GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS_PER_ADDRESS`), and 500 in total. An office of 100 behind one address is admitted in waves of 10 as the clients retry after 2 seconds. A socket that does not authenticate in 5 seconds is closed and costs its address one point (50 points per 60 seconds, then a 5-minute ban).
- **A page-store outage costs the connecting address a point.** A socket counts as authenticated for the limiter when its document connects; only a verifier or sign-in lookup outage is exempt. During a long page-store outage an office of reconnecting clients can reach the ban.
- **A place held by an open that the library dropped silently lasts up to 44 seconds** (the conversion gate's wait, the larger conversion limit and two store timeouts) and is freed when the counts are next consulted.
- **A refusal in the late check at `connected` closes only that document's connection.** A socket whose only document is refused that way stays open without an admitted document.

## Access re-check

- **The re-check fails closed after repeated database failures:** after `max(3, 120 / interval)` failed rounds in a row every remaining connection is closed with `try-again` (4503). With a query that hangs and never settles, only the first failed round waits for the 5-second query timeout (the next rounds count as failed at once while the call is still running), so the time to close is about 5 seconds plus the remaining rounds times the interval: about 3 minutes at the default 60-second interval (3 rounds), about 2 minutes at a 1-second interval. When each query times out and then settles, a failed round costs as long as the query takes to settle (a tick that arrives while a round is still running is skipped and not counted), which is the upper bound. Measured on the unit-test rig with a virtual clock and the default round limit: a query that never settles closes at 124 seconds at a 1-second interval (120 rounds) and at 180 seconds at the default 60-second interval (3 rounds); queries that settle 6 seconds after they start close at 360 seconds at a 1-second interval.
- **Access removal takes effect on live connections within about one minute,** not at once, and a sign-out is not detected until the session expires.

## Saving and importing

- **The largest page is 1,000,000 bytes of editor state.** A long list of short items is limited by it first: about 250 bytes of state per item gives about 3,500 task items on one page. A page over the cap stays readable and editable downward; an edit that would pass it is refused with `state-cap` (4423).
- **The slowest adversarial save shape keeps a margin of about 2x at the cap**: text with edge spaces around marks takes about 4.6 seconds of the 10-second limit on a 4-CPU runner (it was 7.7 seconds). The writing of the Markdown is linear now; the verifying parse that follows is not, so a page of this shape is still bounded by the save time limit (`GRIMOIRE_SAVE_TIMEOUT_MS`) and the per-page breaker, and the state is still stored with the Markdown stale if it ever runs out. Text of many closing brackets is linear too: the serialiser writes the `]` of a document with more than 2,000 of them as `\]`.
- **User-supplied Markdown is limited to 128 KiB, 8,000 lines, 50 markers on a line and 10 seconds.** A hostile import can hold one of the two conversion workers for up to 10 seconds, and two hostile callers at once make a third wait up to one time limit. The tightly packed single-paragraph reference list measured a 1.8x margin.
- **The client is not told when the Markdown of a page is stale.** The server records that it is and since when; showing it needs the web client.
- **A page over the 1 MiB stored-Markdown cap is refused by the save** with the limit named, so that anything stored can be rebuilt; the state is stored and the Markdown stays stale.
