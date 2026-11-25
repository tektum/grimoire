# Hybrid search: the cost of the semantic statement (M7-T14)

What the semantic statement costs over 140,000 chunk vectors of 768 dimensions (10,000 pages of 14 chunks, from a seeded generator, 100 collections, no approximate index), measured by
`apps/server/test/benchmark/hybrid-latency.test.ts` in the `Search latency` job of CI (a hosted 4 vCPU runner, PostgreSQL 17 with pgvector 0.8, one run per shape). A limit is judged on the
median of three p95 values of 30 queries; every value is printed in the job's log and kept as an artifact (`hybrid-latency-<shape>`).

## The limits and what was measured

The limits (R9.10): the statement for a person who sees every collection at most 400 ms (p95), for one who sees 1% of them at most 100 ms, the whole hybrid request at most 1,000 ms.

| Shape of the database | Statement, all collections | Statement, 1% | Hybrid request p95 / max |
|---|---|---|---|
| Roomy: container of 4 GiB, `shared_buffers` 1 GB (the limits are asserted here) | 325 ms (rounds 433, 325, 324) | 6 ms | 323 / 342 ms |
| Staging's class: container of 1 GiB and 2 CPUs, `shared_buffers` 180 MB, `effective_cache_size` 360 MB, JIT off (recorded, not asserted) | 373 ms (373, 363, 384) | 8 ms | 362 / 382 ms |

The statement sits close to its limit, and one run swings by about a quarter (three earlier runs of the same code gave 474, 501 and 389 ms before the limit was judged on a median), so a pass on
a shared runner is not a margin. The staging database (an RDS `db.t4g.micro`: 1 GiB, 2 burstable CPUs, 180 MB of shared buffers) is smaller than this runner in every way that matters, and a
cold cache there is not measured here.

## Where the time went

The plan of the statement is a parallel sequential scan of `page_chunks` (one worker), 477 ms of a 512 ms statement, about 570 MB read through the buffers, with 770,000 buffer hits for 140,000
rows. The table's own pages were 36 MB: each 3 KB vector was stored out of line in the TOAST table (a value over 2 KB is), so a search fetched 140,000 values one at a time. The distance
arithmetic and the join to `pages` (5 ms) were not the cost.

| Variant (p95 of 30 queries, one run each) | Roomy | Staging's class |
|---|---|---|
| As it was | 335 ms | 372 ms |
| `parallel_workers = 4` on the table (two workers ran) | 389 ms | 435 ms |
| `STORAGE MAIN` on the vector (kept in the row) | **109 ms** | **109 ms** |
| `STORAGE MAIN` and `parallel_workers = 4` | 119 ms | 135 ms |

After `STORAGE MAIN` the table is 565 MB of rows and 21 MB of everything else (it was 36 MB of rows and 568 MB of TOAST). More workers did not help; keeping the vector in the row made the
statement three times faster.

## What changed

Migration 0013 sets `page_chunks.embedding` to `STORAGE MAIN`, before any chunk is written (the jobs that write them arrive after it), so nothing needs rewriting. A database that had chunks
before it would keep their out-of-line copies until they are written again. `apps/server/test/migrations/semantic/storage-main.int.test.ts` checks the setting (`attstorage = 'm'`) and that
300 vectors written after it leave the table's TOAST empty.

## Revisit points

- **The approximate index (HNSW)** is not used. The column has no fixed dimension (it holds the vectors of any model), so an index has to be on the typed expression `embedding::vector(768)` and
  a statement has to write the same expression to use it: a change to the statement and one index for each model and dimension. The job records its build time, size, speed and recall against
  the exact scan; the figures are added here when they are in. It is for the case where the exact scan misses its limit even with the vector in the row.
- **200,000 chunks, or a p95 above 400 ms** after the migration: the contract's revisit point.
- **The size of the database.** The exact scan reads all the vectors of the model in use, about 565 MB at 140,000 chunks (about 800 MB at 200,000). It stays fast while those pages stay in the
  cache of the database server; on a machine that cannot hold them it reads from disk on every search. A class with a few gigabytes of memory is what keeps this statement in the range above;
  this was not measured on the managed database itself.
