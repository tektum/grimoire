# Semantic search: quality and cost of the two models (M7-T12)

Measured on one machine (32 shared cores, Node 26, `onnxruntime-node` 1.31.1, `threads = 2` unless stated), with the real model files of `models/models.lock.json` through the embedder as the server uses it (`apps/server/test/semantic/quality.container.test.ts`, the corpus in `apps/server/test/semantic/corpus/`). Re-run it with `node scripts/fetch-models.mjs` and `GRIMOIRE_QUALITY_OUT=file.json bunx vitest run --project container apps/server/test/semantic/quality.container.test.ts`; it is run again, with no network, inside the image (below).

## Recall at 5

The corpus is 46 passages (English, four Hebrew) and 36 queries: 4 synonyms, 17 paraphrases, 8 questions, 3 exact identifiers (`E-4471`, `INV-2025-0099`), 2 English queries against Hebrew passages, 2 Hebrew queries. A query is found when a passage that answers it is among the five most similar. The required figure is 0.8 for the default model.

| Model | Recall at 5 | Misses |
|---|---|---|
| multilingual-e5-base (default) | **1.00** (36 of 36) | none |
| multilingual-e5-small | **0.97** (35 of 36) | "how often does the team meet on Sundays" (English query, Hebrew passage) |

By kind, base: synonym 4/4, paraphrase 17/17, question 8/8, identifier 3/3, English to Hebrew 2/2, Hebrew 2/2. Small: the same except English to Hebrew 1/2. **A caveat about the figure**: 46 passages is a small corpus, and the answer to each query is one of few passages that mention its subject, so 1.00 says the model finds the obvious paraphrase, not how it ranks among thousands of near neighbours. The same corpus is the regression check; it is not an estimate of recall on a real workspace.

## Similarity: where a minimum could be set (`GRIMOIRE_SEMANTIC_MIN_SIMILARITY`)

The cosine similarity of the best passage for each of 10 searches that match nothing in the corpus ("purple elephants dancing quarterly", "zxqv blorptak fnord", a Hebrew sentence about a purple cat, and so on), against that of the best relevant passage of each real query:

| Model | Best passage of a nonsense search (10, sorted) | Best relevant passage of a query (36): lowest, median, highest | Relevant results below the best nonsense one |
|---|---|---|---|
| e5-base | 0.730 0.745 0.755 0.757 0.759 0.759 0.769 0.769 0.772 0.789 | 0.779, 0.840, 0.885 | 2 of 36 |
| e5-small | 0.771 0.773 0.774 0.778 0.781 0.785 0.793 0.796 0.799 0.828 | 0.780, 0.863, 0.925 | 5 of 36 |

**The e5 models compress cosine similarity into the upper part of the range, and nonsense lands in the same band as real answers.** A minimum that removes every nonsense match (above 0.79 for base, above 0.83 for small) would also remove real answers (the lowest relevant result of base is 0.779). So the default of `0` is the right one: the similarity decides the order, not whether a result exists, and the hybrid ranking (reciprocal rank fusion with full text) is what keeps a nonsense search from showing confident results, because a page that full text does not find has only its semantic rank. If an operator sets a minimum anyway, 0.80 on base is the highest value that loses fewer than 1 in 18 real results on this corpus; this is a statement about this corpus and not a recommendation.

## Cost

One text to a model run (the weights are quantised with a scale taken over the whole input, so a text's vector would change with a padded batch's other texts: the first real run of the conformance suite showed it). Chunks of about 217 tokens.

| Model | 1 thread | 2 threads | 4 threads | Resident after load | After 200 chunks | Peak |
|---|---|---|---|---|---|---|
| e5-base | 14.9 chunks/s | 26.0 | 35.7 | 738 MB | 758 MB | 843 MB |
| e5-small | 39.2 | 50.5 | 67.6 | 528 MB | 565 MB | 596 MB |

Memory is the whole server-side process of the probe (embedder thread, model thread, tokenizer once): the peak is the process's own `VmHWM`. The plan measured 0.87 GB (base) and 0.70 GB (small) at peak with the tokenizer twice; the budgets the test enforces are 1.1 GB and 0.9 GB. The load takes 1.2 to 2.5 s on this machine. A page of 14 chunks (about 2,000 words) takes about 0.5 s with the base model at 2 threads.

## Not measured here

- **The image**: no Docker on this machine. Its size is checked against 900 MiB by the `Image and stack` job, which prints it; this file records it once that job has run.
- **Memory inside the 3 GiB container** and the quality run inside the image with `--network none --read-only`: the `Image and stack` job runs the embedder on both models there (`tools/ci/semantic-image-smoke.mjs`); the corpus test above runs on a checkout.
- **Hybrid ranking and the search route** (M7-T14) are not built: what is said about their behaviour above is the reason for the default of 0, to be confirmed by T14's own tests.
