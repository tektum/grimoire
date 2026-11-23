# 13. Semantic search: measured facts and a source assessment (2026-11-20)

Sources: the measurements recorded for the semantic-search work (AMD EPYC 9B45, 32 shared vCPU with a load average of 2 to 10, so timings are noisy; Node v26.13.1) and an assessment of primary sources (nothing measured, called "the assessment" below); the requirements are R9.25 to R9.33, R2.45, R2.46, R4.50, R12.40 and R13.28 in the specification (published later in this series).

## What semantic search adds

It finds synonyms, paraphrases and question-style queries and works across languages with a multilingual model; it is weak at exact words, names and identifiers, cannot explain why a page matched (no highlighting) and does not fix typos (titles use `pg_trgm`, R9.7). It is a second ranking signal, fused with full-text search, not a replacement (the assessment).

## Runtime (measured)

`onnxruntime-node` 1.31.1 (MIT) and `@huggingface/tokenizers` 0.2.0 (Apache-2.0, no dependencies): 18 packages including the root; licences MIT, ISC, BSD-3-Clause, Apache-2.0 and (MIT OR CC0). **The install must set `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`, otherwise its postinstall downloads proprietary NVIDIA CUDA and TensorRT libraries (284 MB).** The Linux x64 CPU payload is 48 MB; the package has no LICENSE or third-party notices file; it needs glibc and libstdc++ (not musl). `@huggingface/transformers` 4.3.2 also works with a `sharp` override, but it pulls 40 packages, `onnxruntime-web` (141 MB) and depends on the override, so it is not used.

## Models on CPU (measured, 200- and 500-token chunks)

| Model | Threads | Load | RSS after load | Peak RSS | Chunks per second at 200 tokens |
|---|---|---|---|---|---|
| e5-small fp32 | 1 / 4 | 937 / 800 ms | 896 / 887 MB | 1,179 / 1,186 MB | 20.1 / 57.5 |
| e5-small int8 | 1 / 4 | 605 / 638 ms | 484 MB | 704 MB | 44.2 / 102.1 |
| e5-base fp32 | 1 / 4 | 1,865 / 1,650 ms | 1,707 / 1,730 MB | 2,183 / 2,177 MB | 5.8 / 20.1 |
| e5-base int8 | 1 / 4 | 803 / 696 ms | 727 / 702 MB | 884 / 870 MB | 16.4 / 49.6 |
| bge-m3 int8 | 1 / 4 | 1,007 / 1,191 ms | 1,310 / 1,332 MB | 1,486 / 1,512 MB | 4.7 / 13.3 |

Cost per save: a 2,000-word page is about 14 chunks, 0.14 to 0.3 s (e5-small int8) or 0.3 to 0.9 s (e5-base int8); a 20,000-word page is about 133 chunks, 1.3 to 3 s or 2.7 to 8 s; Hebrew costs about 40% more. Image impact: about +185 MB (e5-small int8: runtime 48 MB, model 118 MB, tokenizer 17 MB) or +345 MB (e5-base int8). Process memory +0.4 to 0.65 GB steady, peak 0.7 to 0.88 GB. The model ran with no network interface and a read-only root filesystem and no download was seen (no syscall trace). Recommendation of the measurement: e5-base int8 (best strict recall at 5 among the small models, 27 of 30; 0.7 GB; faster than bge-m3), with e5-small int8 as the fallback.

## pgvector (measured)

*Note (decision 141): Google Cloud SQL for PostgreSQL 17 offers pgvector 0.8.5; the development image chosen for search is `pgvector/pgvector:0.8.5-pg17-bookworm` (decisions 124 and 141); today's Compose file still runs plain PostgreSQL 17 because nothing uses pgvector yet, so no pgvector test exists in this repository. The figures below were measured on 0.8.7 and are not re-measured on 0.8.5.*

`pgvector/pgvector:pg17` `sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd`: Debian 12, PostgreSQL 17.12, pgvector 0.8.7, 653 MB. With 20,000 vectors of 768 dimensions: exact search 40 ms with no filter, 1.6 ms when the filter keeps 5 spaces and 12.5 ms for 50 spaces; HNSW build 18 s (78 MB index; `maintenance_work_mem` of 64 MB overflowed); a filtered HNSW query without iterative scans returned 2 of 10 rows (5 spaces) and 9 (50 spaces), with iterative scans 8 to 16 ms and 10 rows.

The model files' sizes and licences: the **MIT licence of the weights comes from the model cards on huggingface.co as read in the assessment**, not from the measurements; the quantised size of `bge-m3` was reported as 568 MB and is not in either source, so it is **unverified**; the assessment gives about 2.3 GB for the unquantised `bge-m3` and 118 MB, 278 MB for the e5 int8 files.

## Not measured, and how weak the evidence is

A real Docker image build; CJK-heavy corpora at scale; concurrent load; HNSW recall on real embeddings (the recall check was unreliable); npm provenance; **the licences of the packages in the pgvector image's Debian base**; Hebrew against a typo-tolerant keyword baseline. The quality test set is tiny (60 passages, 30 queries, written by the measurer), so the recall figure says only that the model ranks sensibly, not how well it will rank an organisation's pages. The licence of the model weights is MIT, but the model cards do not state the licences of the training data (the assessment). The throughput figures come from a noisy shared machine.
