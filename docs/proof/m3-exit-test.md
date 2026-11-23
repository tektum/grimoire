# Milestone 3 exit test: what it proves, how long it takes, and what it does not prove

This note describes the sign-in exit test (`make test-m3`) and its mutation proofs (`make test-m3-mutation`).
Both run against the real stack in Docker Compose. The server runs outside local mode with the real sign-in adapter.
It trusts a small key server that the test starts (`tools/m3-keyserver`), not the live provider. The test mints its own session tokens.

## What the exit test proves

Nine scenarios run one after another, each in its own process. Every check is on a close reason string
(`access-changed`, `session-expired`, `invalid-token`, `try-again`, `full-for-you`, `preauth-timeout`) or, at connect time, on a close code
(4401, 4403, 4404, 4408, 4503) and on the scope the server granted (`read-write` or `readonly`).
A client sees a code of 1000 for an in-session close, so those checks use the reason only.

| Scenario | What it proves |
|---|---|
| `sign-in-matrix` | A good token for a known user edits a page and the edit is stored. An expired token, a token of another issuer, a refresh token and a token signed by another key are refused `invalid-token`. A person with no user row and a suspended user are refused `forbidden`. Nothing a refused client typed reaches the page. |
| `closed-collection` | In a collection with no default permission, a person with no entry is refused `not-found` (4404). A person with a `read` entry is `readonly`, sees the writer's edits, and what the reader types never reaches the writer or the stored page. |
| `read-only` | A viewer role in an open collection, a member of a collection whose default is `read`, and the same member with a `read_write` entry: the first two are `readonly`, the third edits. Read-only typing is never stored. |
| `access-cutoff` | With sessions open, one user is suspended, one loses an entry, one has an entry lowered, one becomes a viewer. Each session is closed `access-changed`; each reconnect gets the connect-time answer (`forbidden`, `not-found`, `readonly`, `readonly`); a bystander is not closed. |
| `session-expiry` | With no fresh token a session is closed `session-expired`. A fresh token for the same user keeps it open past its first expiry. A token signed by another key, or another person's token, closes it `invalid-token`. |
| `user-caps` | The later arrival is refused `full-for-you` and is never told it is authenticated, for sockets and for documents on one socket. Earlier sessions keep editing. Another person is not affected. A freed place can be used again. |
| `key-server-outage` | Stopping the key server closes nobody, and edits are still stored. After the restart (a new key id) a token of the new key signs in, and a token of the old key is refused `invalid-token`. |
| `database-outage` | With the database stopped, an expiring session is still closed `session-expired` on time. A session with a valid token is closed `try-again` only after the configured number of failed re-check rounds. |
| `pre-sign-in` | The 11th not-yet-signed-in socket of one address is refused with status 429 and `Retry-After: 2`. Each of the 10 idle sockets is closed 4408 `preauth-timeout` at the configured timeout. A person can then sign in at once. |

## Mutation proofs

Each protection is broken on purpose from outside the code under test. The scenario must then fail with exactly the expected line.
A pass, or a failure for another reason, fails the target. The job `M3 mutation proofs` of the `Extended` workflow runs it.

| Mutation | Applied by | Scenario | Expected failure |
|---|---|---|---|
| `recheck-off` | the app is recreated with the re-check at 600 s | `access-cutoff` | `timed out: the suspended session to be closed` |
| `recheck-off` | same | `session-expiry` | `timed out: the forged renewal: the session to be closed` |
| `caps-raised` | the per-user socket cap is 1000 | `user-caps` | the fourth socket is not refused (`got "read-write"`) |
| `preauth-timeout-long` | the pre-sign-in timeout is 12 s | `pre-sign-in` | `the timeout is the configured 5 s (...)` |
| `open-closed-collection` | the scenario gives the closed collection a default permission | `closed-collection` | the stranger is not refused `not-found` |
| `unsuspend` | the scenario clears `suspended_at` after its fixture | `sign-in-matrix` | the suspended user is not refused `forbidden` |
| `viewer-as-member` | the scenario gives the viewer the member role | `read-only` | the viewer is not `readonly` |

The last three change data the scenario reads. They prove that the scenario notices the change, not that the server rule is right.
The first four change a setting of the running server, so they break the server's own rule.

## Measured times

Wall time per scenario from one CI run of `make test-m3` (4-CPU runner; difference between the result lines, so it includes each scenario's process start). The whole job took 4 min 44 s, including the image build and the stack start.

| Scenario | Seconds |
|---|---|
| `sign-in-matrix` | 7.4 |
| `closed-collection` | 4.5 |
| `read-only` | 7.3 |
| `access-cutoff` | 6.7 |
| `session-expiry` | 24.9 |
| `user-caps` | 5.8 |
| `key-server-outage` | 27.2 |
| `database-outage` | 120.9 |
| `pre-sign-in` | 5.5 |

Metrics from a later run of the same job (milliseconds):

| Measure | Value |
|---|---|
| access cut-off (all four cases closed in one re-check round) | 4,882 |
| expiry lag (token expiry to the close) | 1,030 |
| key server restart to first sign-in with the new key | 167 |
| database stopped to the expiring session closed `session-expired` | 24,977 |
| database stopped to the valid session closed `try-again` | 120,003 |
| pre-sign-in close of the idle sockets | 5,012 |

The mutation job took 3 min 54 s in total. From now on `make test-m3` also prints one `TIMES` line per scenario with its duration and its recorded metrics (cut-off times, expiry lag, outage times), so later runs carry them.

## Known limits

- The sign-in provider is replaced by a local key server. Nothing here shows how the live provider behaves. The opt-in live check (`.github/workflows/descope-live-m3.yml`) is written and linted but has never been run: its project, test user and secrets do not exist yet.
- The test runs the re-check every 5 seconds, not every 60. The cut-off bound it asserts (25 seconds) follows from that.
- The per-user caps are lowered (3 sockets, 4 documents) and the per-address connection-attempt limit is raised so that one machine can run every scenario. The defaults (20 and 50) are not exercised here.
- The database outage takes about two minutes because the host fails closed after `max(3, ceil(120 / interval))` failed rounds. Nobody is closed before that. There is no mutation proof for this rule and none for the key-server outage: neither can be broken from outside without changing the code.
- After a key-server restart the server may take up to 30 seconds to accept the new key. The scenario retries within 90 seconds and records the time.
- Clients are the provider library of the web client run in Node. No browser takes part.
- All clients connect from one address, and all tokens come from one key server.
- At a pre-sign-in timeout of 30 seconds the idle sockets were seen to end without the 4408 close frame. The default of 5 seconds always sent it. The cause is not known.
- Times come from one run of the CI job on one machine size. They are informational.
