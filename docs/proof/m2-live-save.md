# Proof: the end-to-end save test and live saving

The exit test is `make test-m2` (needs `make up`; it installs from the lockfile, builds, `known-limit.test.mjs` and `own-paragraph.test.mjs`, then five scenarios, each in its own
Node process, against the running Compose stack). Files: `apps/server/test-e2e/m2/`. Results: `test-results/m2/<name>.json` (git-ignored).

What the test is: clients with real editor documents (the shared schema, through the reference editor, see "How the clients write") change a
page through the Hocuspocus server; the server converts the state to Markdown in the worker pool and stores state, Markdown, search text and
hash in one transaction. The assertions are on CONTENT: the Markdown in the row equals the Markdown the reference editor makes of the document
the clients converged on, and every token a client typed is in it exactly once (for the interleavings the test uses; see the known limit above). Seeds are printed on failure (`E2E_SEED=<n>` repeats a run).

## Known limit: concurrent splitting, joining or wrapping of a paragraph can lose text silently

If one person splits, joins or list-wraps a paragraph while another edits the same paragraph, text can be lost, moved or doubled; both screens still
agree, so nothing signals it. This is a documented limit of y-prosemirror 1.3.7 with no fixed version. The exit test avoids these interleavings. So the statements in this note that content is complete hold for typing, range deletion and
heading-level changes, not for these three operations.

Measured with two real editors on the product's plugin array, y-prosemirror 1.3.7, 500 seeded runs per case; no run diverged):

| Person A (at the same time) | Person B | Text lost | Doubled | Moved | Clean |
|---|---|---:|---:|---:|---:|
| types 1 digit / 3 digits | presses Enter (splits) | 0 | 0 | 218 / 346 | 282 / 154 |
| types | Backspace at block start (joins) | 500 | 0 | 0 | 0 |
| types | wraps the block in a bullet list | 500 | 0 | 0 | 0 |
| presses Enter | presses Enter elsewhere | 0 | 417 | 0 | 83 |
| presses Enter | joins | 0 | 457 | 0 | 43 |
| joins | joins | 0 | 500 | 0 | 0 |
| types | types | 0 | 0 | 0 | 500 |
| types | deletes a range | 0 | 0 | 0 | 500 |
| types | sets the heading level | 0 | 0 | 0 | 500 |
| delete / split+delete / type+delete | delete | 0 | 0 | 0 | 500 |

Typing against typing, range deletes and heading-level changes are clean. Two exposure windows: online, one network round trip (both changes must be made
before either arrives); after offline work, as long as the client was away, because everything it did meets everything others did.

Effect on this test: with the restriction removed (splits and deletes made while other clients edit) the `markdown-equals-live`
scenario fails 5 of 5 runs with 5 to 8 tokens missing or doubled. The scenario therefore makes a split or a deletion only while every online client
agrees, and waits for agreement again. It still compares the server's Markdown with the reference editor over the same document, so the server is not
excused; the editor binding is what is not covered (the web client work).

## The typing rule of the scenarios (R3.27), and why the test failed once

Rule: (1) a client's UNSYNCED typing (offline, or before the others have its edits) goes into its own paragraph, the one that starts with its marker
(`Owna `, `Ownb `, `Ownc `, `Ownd `), through the helper `typeInOwnParagraph(client, n)`; no other client types in that paragraph at that time. (2) A
random edit anywhere, including a paragraph split or the deletion of a token (`editSettled`), runs only when all clients are online and hold the same
state, and the scenario waits for agreement again afterwards. `own-paragraph.test.mjs` fails when a scenario file types through any other path.
Still concurrent: typing against typing in different paragraphs by three or four clients, offline work and reconnect, and a late joiner who types at once.

Why: with clients typing at random places, `markdown-equals-live` failed intermittently (2 failures in 5 runs with random seeds, 3 in 4 with seed 0). Cause: not a restructuring (nothing was split or deleted near the damaged token) and not a lost character, but the second known limit below.

## Known limit: two people typing at the same spot can scramble each other's words

What a user sees: if two people type several letters at the same place in a paragraph at the same moment (before either has received the other's
letters), the letters of the two words can end up interleaved, for example `iXYttte` instead of `iXtYtte`. Nothing is lost, nothing is duplicated, and
both screens agree, so nothing signals it. Measured on y-prosemirror 1.3.7 with real editors, 500 pairs per row: one character each at the same spot 500 clean; runs of 2 to 8 characters at the same spot 359 clean
and 141 interleaved (206 of 500 with a marker prefix); runs at different spots in one paragraph 500 clean; runs in different paragraphs 500 clean; lost 0 and
duplicated 0 in every row. Cause: the binding derives an insert by text diffing and anchors it to an existing equal character, so
Yjs's non-interleaving guarantee does not hold. Decision: accept and document (decision 142 in `docs/decisions.md`). The exit test avoids it by the rule above.

No scenario yet measures these two limits through the real server (planned); the figures above come from the editor-level measurements named in each section.

## The scenarios

| Scenario | What runs | Assertion | Duration (three runs of `make test-m2`, see "Runs") |
|---|---|---|---|
| `markdown-equals-live` | Three clients with real editors and a fourth that joins at edit 300, one page seeded from Markdown, 600 random edits under the typing rule below (client b offline for edits 150 to 260, client c for 380 to 470, both keep typing), then convergence | The stored `markdown` equals the reference editor's Markdown over the converged document, character for character; each live token appears once in it and no deleted token appears in it; the search text is stored and contains every live token (it is not checked for duplicates or for deleted tokens). A change the Markdown cannot show (two letters typed and deleted): the state is stored (`ydoc` bytes differ, `ydoc_size` matches, `updated_at` moves on), `markdown`, `text_content` and `markdown_hash` are unchanged, one more `collab.saved` line appears and NO `collab.save_skipped` (that line is for identical state bytes only). Opening and closing the page without an edit leaves `updated_at` and the state unchanged and logs no `collab.saved`. No `collab.convert_alarm` | about 23 to 33 s |
| `seed-once` | The harness inserts a row with non-canonical Markdown (`=====` heading, `*` bullets, a table, a wrapped paragraph) and a null `ydoc`; 20 clients (20 users) open it at once | Exactly one `collab.seed` line for the page, no `collab.seed_failed`; all 20 clients hold the same document and the same canonical Markdown, equal to the canonical Markdown of the stored row | about 10 s (the harness first recreates the app) |
| `restart-mid-edit` | Two clients with real editors type, a first save lands, 12 more edits are typed, `docker compose kill -s KILL app` inside the 3 s debounce window, `start`, wait healthy | `typedBeforeKill` equals `presentAfterRestart` (both at least 200 characters), every token is present once, the two clients' final texts are identical, and the restarted server saves the merged document (the database was behind at the kill: `savedAtKill` is smaller than `typedBeforeKill`) | about 9.5 to 10.7 s |
| `live-size` | A row whose Markdown, tiled, seeds to a state of 720,000 to 780,000 bytes (72 to 78 percent of the default state cap); a client opens it, makes one edit, the save lands while a second client's round trips are timed | The state is in range; one `collab.seed` line; the edit is saved with Markdown and search text; the second client's round trip during the save is under 100 ms; no conversion alarm | about 7 to 9 s |
| `hostile-neighbour` | Five ordinary pages edited continuously for 45 s (page 0 by three clients) with a short debounce (1 s, at most 3 s under continuous typing), TWO hostile pages and a page whose Markdown cannot be seeded (2 MB of `<a`). A hostile page is one whose conversion a test-only switch of the server makes take 15 s, past the 10 s time limit (keyed on a sentinel in its text, so no other page is slowed; refused outside local mode); each is edited once a second. The unseedable page is opened once and the client is dropped at its first refusal. The converter pool is pinned to two workers | Every ordinary page's stored Markdown is never more than 16 s behind its typing and holds every token typed within 15 s of the last edit; each hostile page's last edit is in its stored state and a fresh client sees it; the breaker opens exactly once for each hostile page and each costs at most 2 failed conversions; the unseedable page is refused `seed-failed` (close 4501) with one `collab.seed_failed` line and no stored state; no `collab.store_failed` or `collab.convert_alarm` for an ordinary page; `/healthz` answers throughout. Measured on four CPUs, three runs: worst stale age 10.7 s, catch-up 6.4 to 7.3 s, 1 failed conversion per hostile page. The mutation proof (`make test-m2-hostile-mutation`, breaker disabled) must fail on the staleness: worst age 19.9 to 27.8 s, 4 failed conversions per hostile page | about 2.5 minutes |

`markdown-equals-live` recreates the app container with `GRIMOIRE_LOG_LEVEL=debug` (the `collab.save_skipped` line is a debug line) and recreates it
with the defaults when it ends, as `make test-m1-mutation` does for limits.

How the check can fail (mutations of the exit test, run as part of the proof, results in the "Mutations" section): `M2_FORCE_MISMATCH=1` appends one
character to the expected Markdown; `M2_DROP_EDIT=<n>` makes each client count its n-th typed token without writing it into the document.

## How the clients write

The clients use the HocuspocusProvider with the `Origin` handling of the collaboration host tests and development tokens (`apps/server/test-e2e/support.ts`), not its
`peer()`: that creates a `Y.Text` under the name of the editor fragment, which the converter rightly refuses. Edits go through
a real editor: Milkdown on `grimoireEditorPlugins` and the collab plugin, under happy-dom, one per client, bound to the client's `Y.Doc`
(`m2/reference-editor.mjs`, the same libraries and plugin array as `packages/adapters/markdown-milkdown/src/testing/reference-editor.ts`; written out
because that file is not exported by the package). The `live-size` edit is written into the Yjs fragment
as one schema paragraph, because a 1.1 MB document in a happy-dom editor is not the thing under test.

Tokens (`tb3n17e`: letters and digits only, so Markdown does not escape them) are typed between whole tokens and never inside one. Which paragraph a
client types in, and when it may split or delete, is the rule in the next section.

## The ten host scenarios raise a conversion alarm by design

The ten `make test-m1` scenarios write plain `Y.Text` under the editor's fragment name. The converter refuses such a state (`invalid-state`) and the
server raises `collab.convert_alarm` and stores the state only. They are left as they are (they are not changed); they test sockets, caps,
restarts and flushes, not Markdown. `make test-m1` still prints its ten `PASS` lines.

## Facts a reader needs (each with its source)

- **The converter fails closed.** It refuses a state rather than write Markdown that would lose content (`content-lost`, `too-deep`, `too-large`,
  `invalid-state`), keeps the state and the old Markdown, and the server raises `collab.convert_alarm` once per streak. The accepted differences are
  named: `docs/proof/m2-conversion.md` ("Known limits") and `docs/proof/m2-schema-fixes.md` ("Losses", "Normalisations", "Second-save drift").
- **The corpus.** The real-file count is 12 of 14: twelve of the fourteen real README files keep their meaning through conversion; the other two differ
  only in how a link and a strong are nested (`docs/proof/m2-corpus.md`; its "Findings" section lists the other surprising cases, none hidden).
- **Stale ordered-list numbers.** After concurrent edits of an ordered list, the live editor state keeps stale labels (items 5 and 6 labelled `4.` and
  `5.`) and shows wrong numbers until someone edits the list; the saved Markdown is right (`docs/proof/m2-schema-fixes.md`, "Ordered list numbers on
  screen after concurrent editing"). The exit test's documents contain no ordered list for this reason.
- **Raw HTML and search.** Text inside a raw HTML block is not in the search text (`docs/proof/m2-conversion.md`, "Search text"; the leaf rule gives
  nothing for raw HTML).
- **The largest Markdown that can be loaded into a new page** was about 456 KB of prose, 162 KB of lists and 68 KB of tables when the state cap was 1,536,000 bytes; at the current cap of 1,000,000 bytes the same ratios give about 297 KB, 105 KB and 44 KB (computed, not measured again), and for a user-supplied text the 128 KiB seed limit (R3.21) binds first for prose. The state cap binds before the 1 MiB Markdown limit. Source: measurement, reproduced by
  `apps/server/test/benchmark/seed-limits.test.ts` (`bun run test:benchmark`). The 1 MB Markdown page of the specification is therefore impossible;
  `live-size` records the nearest case (below).
- **A stale page nobody opens is not converted again** until a planned background sweep exists: the row keeps `markdown_stale_since` and the old
  Markdown; the sweep is planned as the job queue `markdown-sweep`.
- **A busy converter stores the state only and retries**, without raising the conversion alarm: the pool gave no room (queue full, waited too long,
  closing), the state is stored, the page is converted on a later save. Test: `packages/adapters/collab-hocuspocus/test/persistence/save.test.ts`
  ("a busy converter is "try again", not a failed page").

## `live-size`: a page near the state cap

Numbers of one `make test-m2` run at the current state cap (1,000,000 bytes), taken on a development machine; the sizes are repeatable (the same tiles give the same
bytes), the timings are not. (The numbers of the scenario at the former cap of 1,536,000 bytes, with a state of 1,153,063 bytes, were `seed-ms` 1,052 to 1,621,
`save-ms` 4,388 to 4,554 and `max-ping-ms` 8.7 to 22.) Re-run with `make test-m2`; the scenario writes them to `test-results/m2/live-size.json`.

```
state-bytes: 770313
markdown-bytes: 186429
bytes-per-markdown-kb: 4231
seed-ms: 880
save-ms: 3915
max-ping-ms: 2.7
```

`state-bytes` is the size of the Yjs state seeded from the Markdown (800 tiles of a heading, a paragraph with bold, emphasis, code and a link, and
two bullets; between the required 720,000 and 780,000). `markdown-bytes` is the size of that Markdown. `bytes-per-markdown-kb` is the state bytes
per KB (1,024 bytes) of Markdown: about 4.1 bytes of state per byte of Markdown for this mixed text, so the cap (1,536,000 bytes when this was measured, 1,000,000 now) is reached at about
370 KB of such Markdown at the former cap and about 240 KB now, far below 1 MB. `seed-ms` is the time from the client's connect to its first sync including the server's seeding (the server's
own `collab.seed` `ms` was 759 in that run). `save-ms` is from the edit to the row holding it; it includes the 3 s debounce (the server's
`collab.saved` line gave `convertMs` 859 and `writeMs` 19 in that run). `max-ping-ms` is the longest answer time of a second client during the
save window: it sends a sync step 1 for its own small page every 10 ms and times the reply (Node's WebSocket cannot send a protocol ping; this
round trip is answered by the same event loop). The idle value was 1.0 ms in that run. During the seed window the
same client saw 124, 181 and 134 ms in three runs at the former cap (112 ms in the current run): that window is recorded in the JSON as `maxPingDuringSeedMs` and not asserted, because the client
that receives the state (1.1 MB under the former cap, 0.77 MB now) applies it in the same process and stalls the timer too.

## Known limit: the epoch does not stop stale tabs

After an epoch change (a page's row is rewritten so that the loaded state is no longer valid), the server closes the page's connections with the
ordinary close code 1000. A client cannot tell that code from a normal drop, so it does not know it must reload. A client that reconnects with a bare
token merges its pre-change edits back, and they are saved at the new epoch: the epoch does not stop a stale tab.  Later work closes this. A reconnect with an old epoch is refused with the reason `stale-epoch`. A moment later the socket is closed with 4409, unless another document on it is open. The save refusal and the first-frame check also close with 4409. The planned web client reloads on the reason or on the code. `known-limit.test.mjs` fails when this
section or the names `1000` and `4409` are missing from it.

## Known limits of the test itself

- **No ordered lists** (stale labels, above) and no tables or images in the random edits; the seed has a heading, bullets, a quote and a code block.
- **The reference editor and the converter are not both run in one process.** Loading the happy-dom globals makes `convertInProcess` fail with
  `internal` in the same process, so `markdown-equals-live` compares with the reference editor only; `seed-once` (no editor) compares through the
  converter.
- **Debug log level** is needed for `collab.save_skipped`; the scenario switches the app container to it and back.

## Stability (load average 3.5 to 6)

Measured on a development machine.

- `make test-m2` ten times in a row from a reset stack (`make down-volumes && make up`): 10 of 10 exit 0, 5 PASS and 0 FAIL each, 5 passing JSON files each, 70 to
  75 s per run including the install and the build. Scenario durations over the ten runs: `markdown-equals-live` 31.3 to 34.0 s, `seed-once` 1.3 s, `restart-mid-edit` 9.4 to 10.5 s,
  `live-size` 7.3 to 7.8 s, `hostile-neighbour` 13.2 to 13.6 s. These ten-run and thirty-run records were taken with EARLIER versions of the scenarios (`hostile-neighbour` then had no 45 s typing loop and `seed-once` did not recreate the app; the state of `live-size` was 1.1 to 1.2 MB under the former cap); they record that those versions passed every time, not the durations of the current scenarios. One current run on a development machine (the results files in `test-results/m2/`): `markdown-equals-live` 24.9 s, `seed-once` 10.0 s, `restart-mid-edit` 9.4 s, `live-size` 5.7 s with a state of 770,313 bytes, `hostile-neighbour` 61.7 s (45 s of typing).
- `markdown-equals-live` alone 30 times: 30 of 30 PASS, 30.9 to 33.2 s each. Seeds: 0 and 82362642 (the two that failed before the rule), then 48653608 1028820433 965798161 862958783
  844064807 335729422 321372374 210196343 733935726 445595536 331441831 575060769 472763870 547660761 916391695 363609854 667852777 409308141 88455749 325793882
  190116643 399526797 546042096 749809398 420550445 107756902 124750149 68302280. 
- Mutations, seed 1: `M2_FORCE_MISMATCH=1` gives `FAIL markdown-equals-live: timed out: the stored Markdown to equal ... (stored 5170 chars, expected 5171 ...)`;
  `M2_DROP_EDIT=20` gives `FAIL markdown-equals-live: every token typed ... got ["ta20n20e","tb20n20e","tc20n20e","td20n20e"]`.

## Mutations of the exit test

- `M2_FORCE_MISMATCH=1 make test-m2` (also with `E2E_SEED=<n>`): appends one character to the expected Markdown. Result: exit 2, `FAIL markdown-equals-live: timed out: the stored
  Markdown to equal the reference editor's Markdown (stored 5041 chars, expected 5042; ...)`; the other three scenarios print `PASS`.
- `M2_DROP_EDIT=20 node apps/server/test-e2e/m2/run.ts markdown-equals-live`: each client counts its 20th typed token without writing it into the
  document, like a client that loses an edit. Result: `FAIL markdown-equals-live: every token typed and not deleted is in the converged document exactly
  once ... got ["ta20n20e","tc20n20e","tb20n20e"]`.
- `known-limit.test.mjs` with `4409` renamed in this note fails ("the stale-tab section names 4409").

## What the test does not prove about the reference editor and search text

The reference editor (`m2/reference-editor.mjs`) imports the product's plugin array (`grimoireEditorPlugins`) but duplicates the editor set-up: the
Milkdown core wiring and the simulated DOM (happy-dom) are written out twice, so they can drift from `src/testing/reference-editor.ts` and from the browser.
`live-size` checks that the search text is stored (not empty), not what it contains.
