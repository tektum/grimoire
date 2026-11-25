# Hybrid search: the cost of the semantic statement (M7-T14)

What the semantic statement costs over 140,000 chunk vectors of 768 dimensions (10,000 pages of 14 chunks, from a seeded generator, 100 collections, no approximate index), measured by
`apps/server/test/benchmark/hybrid-latency.test.ts` in the `Search latency` job of CI (a hosted 4 vCPU runner, PostgreSQL 17 with pgvector 0.8, one run per shape). A limit is judged on the
median of three p95 values of 30 queries; every value is printed in the job's log and kept as an artifact (`hybrid-latency-<shape>`).

## The limits and what was measured

The limits (R9.10): the statement for a person who sees every collection at most 400 ms (p95), for one who sees 1% of them at most 100 ms, the whole hybrid request at most 1,000 ms. The numbers
below are of the schema as it ships (the vector stored in the row, migration 0013), from one run of the job on the pull request that added it; the limits are asserted on the roomy shape.

| Shape of the database | Statement, all collections | Statement, 1% | Hybrid request p95 / max |
|---|---|---|---|
| Roomy: container of 4 GiB, `shared_buffers` 1 GB (the limits are asserted here) | 192 ms (rounds 181, 193, 192) | 5 ms | 199 / 209 ms, no fallback |
| Staging's class: container of 1 GiB and 2 CPUs, `shared_buffers` 180 MB, `effective_cache_size` 360 MB, JIT off (recorded, not asserted) | 167 ms (194, 167, 155) | 12 ms | 164 / 175 ms, no fallback |

That is about twice under the 400 ms and five times under the 1,000 ms limit. The runner is a hosted 4-vCPU machine whose own page cache is not limited by the container; a managed database of
staging's class (an RDS `db.t4g.micro`: 1 GiB, 2 burstable CPUs, 180 MB of shared buffers) was not measured, and the next section is why that matters.

## Where the time went

With the vector out of line in the TOAST table (the layout before migration 0013, recorded by the same run by rewriting the table), the same statement took 638 ms on the roomy shape and **1,906 ms**
on staging's: the table is 547 MB of rows and 562 MB of TOAST, more than the 1 GiB container keeps in memory, so a search reads a good part of it again. With the vector in the row the table is 547 MB
of rows and 9 MB of everything else, and the statement took 181 ms (roomy) and 158 ms (staging's shape) in the same run. An earlier layout run gave 325 to 472 ms on the roomy shape, so it swung
widely between runs: that is why the limits are asserted on the shipped schema and the old layout is only recorded.

The plan of the statement is a parallel sequential scan of `page_chunks`; the join to `pages` is 5 ms. More scan workers on the table (`parallel_workers = 4`) changed nothing (178 and 151 ms).

## What changed

Migration 0013 sets `page_chunks.embedding` to `STORAGE MAIN`, before any chunk is written (the jobs that write them arrive after it), so nothing needs rewriting. A database that had chunks
before it would keep their out-of-line copies until they are written again. `apps/server/test/migrations/semantic/storage-main.int.test.ts` checks the setting (`attstorage = 'm'`) and that
300 vectors written after it leave the table's TOAST empty.

## Revisit points

- **The approximate index (HNSW)** is not used. The column has no fixed dimension (it holds the vectors of any model), so an index has to be on the typed expression `embedding::vector(768)` and a
  statement has to write the same expression to use it: a change to the statement and one index for each model and dimension. Measured on this data (547 MB, built in 139 to 152 s, with
  `hnsw.iterative_scan = relaxed_order` and `ef_search = 400`): for every collection the p95 was 91 ms (roomy) and 2,330 ms (staging's shape), and the **recall of the 300 nearest chunks against the exact
  scan was 0.17**; for 1% of the collections the recall was 1.0 at 21 to 28 ms. The vectors here are uniformly random, which is the worst case for a graph index (real embeddings cluster), so the recall is a
  floor and not a forecast; it was not measured on real embeddings. An index that finds a fifth of the right chunks, and slower on a small cache, is no answer to a statement that is already within its limit.
- **200,000 chunks, or a p95 above 400 ms** after the migration: the contract's revisit point.
- **The size of the database.** The exact scan reads all the vectors of the model in use, about 547 MB at 140,000 chunks (about 780 MB at 200,000). It stays fast while those pages stay in the cache of
  the database server, and the out-of-line layout shows what happens when they do not (1.9 s). A class with a few gigabytes of memory is what keeps this statement in the range above; this was not
  measured on the managed database itself.
