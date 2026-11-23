# File store identities in Compose

Pinned image: `chrislusf/seaweedfs:4.54`.

## What the source of the pinned release says

| Question | Answer | Where |
|---|---|---|
| Does `weed mini` accept `-s3.config=<file>`? | Yes: `mini` declares the `s3.config` flag. | `weed/command/mini.go` at tag 4.54 |
| How does it combine with `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`? | The environment pair is added as a static admin identity named `admin-<first 8 characters of the key>`. A configuration load keeps identities with that prefix, so the file only adds identities. | `weed/s3api/auth_credentials.go` at tag 4.54 |

This was read from source, not measured on a running container (no local container runtime was available while writing this).
The measurement is the Compose integration check in CI: it signs requests with the runtime pair read from `.env`.

## Result

- `admin`: the existing development pair (`GRIMOIRE_DEV_S3_*`), used by the healthcheck and bucket setup.
- `app`: `GRIMOIRE_DEV_S3_APP_*`, rendered from `.env` through a top-level `configs:` entry; actions `Read`, `Write` and `List` on `GRIMOIRE_S3_BUCKET` (default `grimoire`).
- The app service receives only the `app` pair. No file with a key value is committed other than `.env.example`.
- An existing `.env` without the two new variables makes Compose stop with a message naming them.
