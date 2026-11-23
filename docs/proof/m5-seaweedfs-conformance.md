# Proof: the file store adapter against SeaweedFS

Store: `chrislusf/seaweedfs:4.54` as pinned in `compose.yaml` (`weed mini -s3` with the two identities of the Compose file: the admin identity and the runtime identity that may read, write and list the `grimoire` bucket only). Adapter: `packages/adapters/files-s3`. The client talks to `http://127.0.0.1:8333`; signed URLs carry `http://localhost:8333`, which is not one of the application's origins.

Run: the integration job of the pull request that added these tests (`make db-up`, then `bun run test:integration`), files `file-storage.conformance.int.test.ts` and `credentials.int.test.ts`. Both passed in full: 21 tests in the first file (the 20 cases below and a check that every case ran), 4 in the second. No case was skipped: the store has every capability the suite names.

## Cases of the conformance suite

The same cases the in-memory fake passes. The create-only header is the default one, `if-none-match`.

| Case | Result |
|---|---|
| `put-head-get` | pass |
| `range-first-512` | pass |
| `range-middle` | pass |
| `range-past-end` | pass |
| `get-absent` | pass |
| `delete-absent` | pass |
| `list-paging` | pass |
| `key-validation` | pass |
| `put-conditional-412` | pass |
| `sign-upload-exact` | pass |
| `sign-upload-wrong-size` | pass |
| `sign-upload-wrong-type` | pass |
| `sign-upload-no-overwrite` | pass |
| `create-only-header-stripped` | pass |
| `sign-upload-expired` | pass |
| `sign-download-overrides` | pass |
| `signed-urls-use-public-endpoint` | pass |
| `anonymous-denied` | pass |
| `cors-preflight` | pass |
| `stream-200mb-flat-memory` | pass |

`create-only-header-stripped` passing means the store enforces the headers that are signed: an upload from which the client removed the create-only header is refused, so the signature is what protects an existing object.

## Credentials

`credentials.int.test.ts` passes. With the runtime key, through the adapter: creating a bucket and setting CORS are refused with 403; every call on a bucket that is not the runtime key's own is refused; an unsigned read and an unsigned listing are 403. `ensureBucket` with the admin key succeeds twice and the CORS rule reads back with the application's origins, the methods `GET`, `HEAD` and `PUT`, `ETag` exposed and a maximum age of 600.

## Findings

- The store cannot hold a path segment longer than 255 bytes (the first run answered HTTP 400 to a valid 512-byte key made of one segment). The key contract therefore refuses such a segment for every adapter; keys the product builds are short.
- The memory case reads the process's resident memory, and socket buffers count until the collector has run. The first run measured 71 MB of growth that were only waiting to be collected (13 MB with a collection forced in a probe against a local streaming server). The case now asks for a collection while it streams; a store or adapter that keeps the whole upload still fails it.
- The other create-only header (`x-goog-if-generation-match`) is not run against this store: it is covered by the recording-server tests of the adapter, which check what is signed and sent.
