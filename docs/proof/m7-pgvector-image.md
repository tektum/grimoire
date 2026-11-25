# M7-T10: the pgvector database image

Everything here was produced by CI (no container runtime is used locally), on pull request #332, head c638f21.

| What | Result | Run |
|---|---|---|
| Integration tests on the new image (`pgvector/pgvector:0.8.5-pg17-bookworm`), the whole suite, `make db-up` | 89 files, 692 tests passed (689 without the 3 tests of `pgvector.int.test.ts`, by subtraction; the count before the swap was not recorded separately). Run on an earlier head of the PR; the later commits change the audit and its workflow only | https://github.com/tektum/grimoire/actions/runs/45511398851/job/138859912430 |
| `pgvector.int.test.ts` on 0.8.5 (inside the suite above) | 3 passed: version `0.8.5`, the runtime role can use `<=>` and cannot `create extension`, 768 and 384 dimensions in one column | same job |
| `make test-pgvector-087` on `pgvector/pgvector:pg17@sha256:b513c485...` (pgvector 0.8.7) | `pgvector.int.test.ts`: 3 passed (the other two files of the contracts, `embeddings/store.int.test.ts` and `search/hybrid/permissions.int.test.ts`, are added to `PGVECTOR_TESTS` by M7-T11 and M7-T01) | https://github.com/tektum/grimoire/actions/runs/45515006154/job/138872053195 |
| Package audit of the image `compose.yaml` names, against the same Debian release | exit 0: 8 added packages, all covered by an exception (below) | https://github.com/tektum/grimoire/actions/runs/45515006154/job/138872052977 |
| The same audit for the 0.8.7 image | exit 0: the same 8 packages (`libpython3.11-minimal`/`python3.11-minimal` at `deb12u9`) | same run, step "The same audit for the second image" |

## What was compared, and the policy

The baseline is `postgres:17-bookworm@sha256:1eff563f...`, the same Debian release as the pgvector image (an earlier comparison with the `postgres:17` image that Compose used before listed 35 packages; most were that image's other release naming the same base libraries differently, which is why a baseline of the same release is used). What is listed is what the pgvector image adds to the same base.

The permitted-licence list covers the code we ship and link. These 8 are Debian operating-system packages inside a third-party database image that is pulled by digest and never linked to or shipped as part of Grimoire's code (aggregation, as with the `postgres` image before it). They are recorded in `tools/licence-report/image-exceptions.json` by the manager on behalf of the owner. Any package that is not in that file and is new, not permitted or without licence data fails the audit.

Seven of the 8 (`binutils-common`, `libcrypt-dev`, `libpython3.11-minimal`, `libtirpc-common`, `media-types`, `python3`, `python3.11-minimal`) show no licence: their copyright files are free text that names none of the licences the audit recognises (GNU licences, Apache, PSF), so the audit has no licence data for them. They are excepted on the same grounds, not identified.

## Packages added by the database image

Old image: `postgres:17-bookworm@sha256:1eff563f6c868b9b433566e9f3cf6e5c79fbd3b95bf70ec7277d376cdbfc50d7`
New image: `pgvector/pgvector:0.8.5-pg17-bookworm@sha256:d2ef61f42ef767baa5a1475393303cc235bcd92febd9d7014eddb48b41f3bad0`

144 package(s) are in both images (the image base) and are not listed.

8 package(s) in the new image and not in the old one; 0 not permitted and without an exception.

| Package | Version | Licences | Result |
|---|---|---|---|
| binutils-common | 2.40-2 | - | exception: Debian OS package in the third-party database image; aggregation, not a dependency of Grimoire code (owner: manager, on behalf of the owner) |
| dpkg-dev | 1.21.23 | BSD-2-Clause, GPL-2, GPL-2+, public-domain-s-s-d | exception: Debian OS package in the third-party database image; aggregation, not a dependency of Grimoire code (owner: manager, on behalf of the owner) |
| libcrypt-dev | 1:4.4.33-2 | - | exception: Debian OS package in the third-party database image; aggregation, not a dependency of Grimoire code (owner: manager, on behalf of the owner) |
| libpython3.11-minimal | 3.11.2-6+deb12u7 | - | exception: Debian OS package in the third-party database image; aggregation, not a dependency of Grimoire code (owner: manager, on behalf of the owner) |
| libtirpc-common | 1.3.3+ds-1 | - | exception: Debian OS package in the third-party database image; aggregation, not a dependency of Grimoire code (owner: manager, on behalf of the owner) |
| media-types | 10.0.0 | - | exception: Debian OS package in the third-party database image; aggregation, not a dependency of Grimoire code (owner: manager, on behalf of the owner) |
| python3 | 3.11.2-1+b1 | - | exception: Debian OS package in the third-party database image; aggregation, not a dependency of Grimoire code (owner: manager, on behalf of the owner) |
| python3.11-minimal | 3.11.2-6+deb12u7 | - | exception: Debian OS package in the third-party database image; aggregation, not a dependency of Grimoire code (owner: manager, on behalf of the owner) |
