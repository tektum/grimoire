# The exit test of search and import (M7)

DRAFT. Two lines are marked TBD (the restart scenario of #505, and the limits of #519); everything else is read from a run that is named.

M7 is the search (full-text, and by meaning), the scheduled jobs, and the import of Markdown zips and of an export of Notion. This file says, for each thing the milestone promises, what proves it: the pull request, the test file or the group, the CI job and run, and the figure that run printed. A figure without a run beside it is not in this file.

## How to run it

```sh
make down && make up && make test-m7        # no secret, no network beyond localhost
make test-m7-real                           # the real export: skips with exit 0 and says so when GRIMOIRE_NOTION_EXPORT is unset
```

`make test-m7` (#489, `mk/test-m7.mk`) runs every group of `apps/server/test/m7/groups.json` in turn and prints `PASS <group>` for each, or `PENDING <group>: <file>` for a group whose test is not written yet, so a missing test cannot read as a pass. `apps/server/test/m7/target-list.test.ts` checks the list.

CI runs it nightly and on demand as the job `M7 exit test (make test-m7)` of the Extended workflow (#517). The same tests also run, split by kind, in the jobs of every pull request: Integration, `Semantic models`, `Search latency`, the browser jobs, and `Exit test M5` (which also holds the restart scenario).

### The nightly run

Run 45818571461 (a dispatch of the Extended workflow for #517), job `M7 exit test (make test-m7)`, 12:30:17Z to 12:40:11Z (9 min 54 s), success. Per group, as the target printed it:

| Group | Test files | Tests | Result |
|---|---|---|---|
| search | 14 | 172 | PASS |
| jobs | 22 | 174 | PASS |
| hostile | 3 | 43 | PASS |
| synthetic | 13 | 245 | PASS |
| remote-images | 4 | 48 | PASS |
| restart | 1 | - | PENDING at that run; moves to a pass with #505 (TBD below) |
| semantic | 22 | 86 | PASS |
| security | 3 | 135 | PASS |

## What proves each behaviour

### Search

| Behaviour | Proof |
|---|---|
| A person never sees a page of a collection they cannot read, under the tenant model | #492: `apps/server/test/m7/search-permissions.int.test.ts`, 24 tests (viewer, member, admin, group grant, the collection's default permission, a suspended person, a deleted collection, a page in the trash, the other tenant). Integration 1056 of 1056 on 4f93ff83. Its first run failed 2 tests (fuzzy title search); they were fixed and the run above is the fixed one |
| Every route of search and import answers an id of another tenant with 404 | #494: `apps/server/test/security/tenant-walk.test.ts` and `apps/server/test/m7/operations.test.ts`. The API had 46 operations then (39 before M7, plus search and the six import routes; the contracts said 45); the three upload routes of #511 make it 49, which `apps/server/test/m7/operations.test.ts` now counts. The operations that are not walked are an exact list of 29 ids that fails when a route with an id in its path is added. Integration 1056 of 1056, Chromium 474 passed |
| A search over 10,000 pages answers inside the limit (R9.10) | `docs/proof/m7-search-latency.md`, job `Search latency`: a person who reads all 100 collections, median 73 ms and worst of 7 at 120 ms (limit 1,000 ms); one collection in a hundred, 11 ms and 16 ms (limit 100 ms); a small tenant, 6 ms and 17 ms |
| The search by meaning and by words together keeps its latency | `docs/proof/m7-hybrid-search.md` (#438, #442, #483): on a roomy database (4 GiB, limits asserted) the semantic statement takes 192 ms for all collections and 5 ms for 1%, the hybrid request p95 199 ms and max 209 ms with no fallback; on staging's class (1 GiB, 2 CPUs, recorded) 167 ms and 12 ms, p95 164 ms and max 175 ms |

### Search by meaning

| Behaviour | Proof |
|---|---|
| The two models: recall, similarity, cost | `docs/proof/m7-semantic-quality.md` (#417): recall at 5 of 36 queries, e5-base 0.97 (35 of 36) and e5-small 0.94 (34 of 36); cost 14.3 chunks/s on 1 thread to 34.1 on 4 for e5-base, resident 744 MB after load and 829 MB at peak |
| The fused list finds what full text cannot | #500: `apps/server/test/semantic/fused-recall.container.test.ts`, run 45778150140, job 139768317783 (`Semantic models`): recall at 5 on the 36 queries, fused 0.972 (35 of 36) against full text alone 0.056 (2 of 36). By kind, fused against full text: synonym 4 of 4 and 0; paraphrase 17 of 17 and 0; question 8 of 8 and 0; identifier 3 of 3 and 2; Hebrew query 2 of 2 and 0; English to Hebrew 1 of 2 and 0. The three identifier queries find their page first in the fused list |
| The semantic search end to end on the real server and the real model | #499: `apps/server/test/semantic/e2e.container.test.ts` (not `apps/server/test/m7/semantic.int.test.ts`: the Integration job has no model files, so the test lives with the container project; the `semantic` group lists that directory). Run 45778574648, job 139771317153, head 56b0971d: 28 tests passed in 4 files, the end-to-end test 26,499 ms. It asserts that the sweep embedded both pages within 90 s; that a person asking "time off" gets the holiday page first, `semantic: true`, with a matched passage holding "holiday" (neither page holds "time" or "off"); that another person gets the same body before and after and none of the id, title or text of the page they cannot read; and that with the semantic search off the answer says `semantic: false` and "vacation" still finds the page |
| Embedding a long page does not stop the event loop | #493, #518 (the tokenizer moved to the model thread), #512 (the test tells a stall of the machine from a stall of the process): `apps/server/test/semantic/event-loop.container.test.ts`. Main run 45828439091, job 139941118378 (`Semantic models`, head 0d4e78bd), success, 31 tests in 5 files: a page of 20,000 words in 200 chunks, embedded in 15,447 ms while 20 saves ran (slowest 28 ms); event-loop delay p99 14.7 ms and maximum 18.35 ms (limits 50 ms and 200 ms); no stall, no machine stall, no GC pause listed. Before #518 the maximum was 36 ms in the first run of the test, and a run of #506's head and a main run each failed on a single stall of 678 ms and 428 ms, the kind of stall #518 addresses |
| The database image has the vector extension | `docs/proof/m7-pgvector-image.md` (M7-T10): the Integration suite on the new image, the three tests of `pgvector.int.test.ts` (version 0.8.5, the runtime role can use `<=>` and cannot create the extension, 768 and 384 dimensions in one column), and `make test-pgvector-087` on 0.8.7 |

### Jobs and restart

| Behaviour | Proof |
|---|---|
| Scheduled jobs: purge, upload cleanup, revision catch-up, import sweep; one waiting run for two replicas and for a restart; the failing job says why | #403, #404, #405 (schedules are a chain of sends, `stately` queues, migrate replaces a queue of another policy), #427, #450, #476. The `jobs` group of the nightly run above: 22 files, 174 tests |
| The expiry of a run of the import is a setting that reaches the queue | #510: the queue is defined by `migrate`, so the setting is passed to it, an existing queue takes the new expiry in place, and the value is bounded at 24 hours (the limit of the job queue). `apps/server/test/migrations/import-expiry.int.test.ts` (the real `migrate` process: 900 s, then 20 s on an existing database, then 900 s), Integration 1078 of 1078 on head 00fe01f4, 3.4 s |
| An import survives `docker kill` and `docker stop` of the application, with every page and attachment once | #505, `apps/server/test/m7/restart.container.test.ts`, run by the `Exit test M5` job. TBD: the two result lines (`"restart":"kill"` and `"restart":"stop"`), the measured time until the import is taken up again in each case, and the job and run ids, to be read from the first run that passes. What a run has shown so far: with the queue expiry at 20 s a run killed at 50 pages is taken back and finishes (the importer counts 401 pages for the 400 files, with the page it makes for their folder); a graceful stop ends the job and the import stays `running` until the `import-sweep` job finds it (R10.16, every 5 minutes by default, every minute in this test) |

### Import

| Behaviour | Proof |
|---|---|
| Hostile zips are refused or skipped with a reason, nothing is written to disk | The `hostile` group (`apps/server/test/import/hostile/*`, M7-T03, with cheaper bomb fixtures from #458): 3 files, 43 tests in the nightly run above |
| A synthetic export end to end, with the shapes a real export writes | #481 and the Notion work #465 to #474 and #487: the `synthetic` group, 13 files, 245 tests in the nightly run above. The synthetic Notion export holds the shapes the real one showed (ids in names, `_all.csv` twins, callouts, databases and their rows, an export in parts) |
| Images from the web are copied into the tool, within budgets, and the report says how many were not | #445, #449, #441 (the files a page uses become its attachments). The `remote-images` group (`apps/server/test/import/remote-images/*` and `apps/server/test/import/engine/remote-hook.test.ts`): 4 files, 48 tests in the nightly run above. The contracts named a file `remote-images.int.test.ts`; the group is that test, and no second file was written |
| The import report says what became of the content: converted, left out, kept | #504 (the server counts the constructs by kind, as occurrences), #506 (the screen: `apps/web/src/screens/import/ConstructReport.tsx`, with the pages and the HTML left to clean up; shown only for a finished import, because a failed or cancelled import has its pages in the trash). Chromium 479 passed on the gate of c30f6cd6; screenshots in `docs/screenshots/m7-construct-report/` |
| The import against a real export of Notion | `docs/proof/m7-real-export.md` (#479, aggregates only, no names and no content): 6,305 pages, 272 CSV files, 10,241 links of which 2,618 relative, 1,166 callouts in 337 pages, 829 images (690 of the files that pages use imported, 38 refused by type), 3,298 pages that are a database's rows (2,316 of them hold nothing but their columns and are left out), and 2 pages over the 128 KiB seed cap (skipped as `too_large`). The target `make test-m7-real` runs it and skips with exit 0 when no export is set; the export itself is private and is not in the repository |
| An export in parts (two zips over 500 MiB each, pages of one using files of the other) | #466 (the first answer: `nested_or_split_export`, and what to do), #496 (the file store takes a multipart upload through signed part URLs), #501 (an import keeps its zips as parts), #511 (upload routes for a file that goes up in parts), #514 (the import job reads the zips of an export in parts as one archive), #509 (the file types a real export holds, `video/quicktime` and `image/heic`, are accepted). Each has its tests in the Integration job of its pull request |
| The limits of a big import: how many zips, how many bytes, what one file may be, and what the screen says | TBD: #519 (the limits in `/v1/config`, `too_large` and `staging_quota` on create, `attachments_too_large`), when it is merged, and the wording of the screen that follows it |

## What changed from the contracts, and why

- The count of operations was 46, not 45 (39 on main when M7 began, plus search and the six import routes), and is 49 with the upload routes of #511.
- The semantic end-to-end test is `apps/server/test/semantic/e2e.container.test.ts`, not `apps/server/test/m7/semantic.int.test.ts`: the Integration job has no model files.
- The remote-image import test is a group of existing files, not one new file.
- The restart scenario runs in the `Exit test M5` job (the stack with the file store is already there) and in `make test-m7`; it is not a job of its own.
- The nightly job runs `make test-m7` only. The real export is run by the owner with `make test-m7-real` and stays private.

## Build and hygiene

Every pull request of the milestone passed the gate of the repository before it merged: build, typecheck, lint, gitleaks, the unit and integration tests with their coverage floors (which only rise), and the browser jobs, which since #502 are part of `CI Required` together with `Semantic models` and `Search latency`.
