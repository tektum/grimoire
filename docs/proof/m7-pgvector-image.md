# M7-T10: the pgvector database image

Everything here was produced by CI (no container runtime is used locally), on pull request #332, head 550c044.

| What | Result | Run |
|---|---|---|
| Integration tests on the new image (`pgvector/pgvector:0.8.5-pg17-bookworm`), the whole suite, `make db-up` | 89 files, 692 tests passed (689 without the 3 tests of `pgvector.int.test.ts`, by subtraction; the count before the swap was not recorded separately) | https://github.com/tektum/grimoire/actions/runs/45511398851/job/138859912430 |
| `pgvector.int.test.ts` on pgvector 0.8.5 (inside the suite above) | 3 passed: version `0.8.5`, runtime role can use `<=>` and cannot `create extension`, 768 and 384 dimensions in one column | same job |
| `make test-pgvector-087` on `pgvector/pgvector:pg17@sha256:b513c485...` (pgvector 0.8.7) | `pgvector.int.test.ts`: 3 passed. The other two files named in the contracts (`embeddings/store.int.test.ts`, `search/hybrid/permissions.int.test.ts`) belong to M7-T11 and M7-T01 and are added to `PGVECTOR_TESTS` with them | https://github.com/tektum/grimoire/actions/runs/45511398683/job/138859715898 |
| Package audit, `image-packages.mjs --compare` | **exit 1: 35 packages for the owner to decide** (table below) | https://github.com/tektum/grimoire/actions/runs/45511398683/job/138859715438 |

The audit is for the owner: the 35 packages are Debian 12 system libraries and tools that the pgvector image has and the `postgres:17` image of the pinned digest does not (why they differ was not looked into). None is code of this project. Their licences are mostly GPL or LGPL, which the permitted list refuses, and a few have no copyright file at all; they are listed, not accepted. An exception is an entry (package, owner, reason) given to `--exceptions`; none has been made.

## Packages added by the database image

Old image: `postgres:17@sha256:b60e90042aa6b8dbecd58e224b3e36114dbf8ad754465264c2476ad58a86e45c`
New image: `pgvector/pgvector:0.8.5-pg17-bookworm@sha256:d2ef61f42ef767baa5a1475393303cc235bcd92febd9d7014eddb48b41f3bad0`

35 package(s) in the new image and not in the old one; 35 for the owner to decide.

| Package | Version | Licences | Result |
|---|---|---|---|
| binutils-common | 2.40-2 | - | no-licence-file: /usr/share/doc/binutils-common/copyright is missing |
| dpkg-dev | 1.21.23 | - | no-licence-file: /usr/share/doc/dpkg-dev/copyright is missing |
| e2fsprogs | 1.47.0-2+b2 | Apache-2.0, BSD-3-Clause, GPL, GPL-2, GPL-2+, ISC, Kazlib, Latex2e, LGPL-2 | not-allowed: not on the permitted list: GPL, GPL-2, GPL-2+, Kazlib, Latex2e, LGPL-2 |
| gcc-12-base | 12.2.0-14+deb12u1 | - | unparsable: the copyright file names no licence |
| gnupg-utils | 2.2.40-1.1+deb12u2 | BSD-3-Clause, CC0-1.0, MIT, GPL-3+, LGPL-2.1+, LGPL-3+, permissive, RFC-Reference, TinySCHEME | not-allowed: not on the permitted list: GPL-3+, LGPL-2.1+, LGPL-3+, permissive, RFC-Reference, TinySCHEME |
| gpg-wks-client | 2.2.40-1.1+deb12u2 | BSD-3-Clause, CC0-1.0, MIT, GPL-3+, LGPL-2.1+, LGPL-3+, permissive, RFC-Reference, TinySCHEME | not-allowed: not on the permitted list: GPL-3+, LGPL-2.1+, LGPL-3+, permissive, RFC-Reference, TinySCHEME |
| gpg-wks-server | 2.2.40-1.1+deb12u2 | BSD-3-Clause, CC0-1.0, MIT, GPL-3+, LGPL-2.1+, LGPL-3+, permissive, RFC-Reference, TinySCHEME | not-allowed: not on the permitted list: GPL-3+, LGPL-2.1+, LGPL-3+, permissive, RFC-Reference, TinySCHEME |
| gpgv | 2.2.40-1.1+deb12u2 | BSD-3-Clause, CC0-1.0, MIT, GPL-3+, LGPL-2.1+, LGPL-3+, permissive, RFC-Reference, TinySCHEME | not-allowed: not on the permitted list: GPL-3+, LGPL-2.1+, LGPL-3+, permissive, RFC-Reference, TinySCHEME |
| libapt-pkg6.0 | 2.6.1 | BSD-3-Clause, MIT, GPL-2, GPL-2+ | not-allowed: not on the permitted list: GPL-2, GPL-2+ |
| libassuan0 | 2.5.5-5 | GAP, GAP~FSF, GPL-2+, GPL-3+, LGPL-2.1+, LGPL-3+ | not-allowed: not on the permitted list: GAP, GAP~FSF, GPL-2+, GPL-3+, LGPL-2.1+, LGPL-3+ |
| libcrypt-dev | 1:4.4.33-2 | - | no-licence-file: /usr/share/doc/libcrypt-dev/copyright is missing |
| libdb5.3 | 5.3.28+dfsg2-1 | Artistic, BSD-3-Clause, BSD-3-clause-fjord, GPL, GPL-3, MIT-old, Ms-PL, Sleepycat, TCL-like, X11, zlib | not-allowed: not on the permitted list: Artistic, BSD-3-clause-fjord, GPL, GPL-3, MIT-old, Ms-PL, Sleepycat, TCL-like, X11, zlib |
| libext2fs2 | 1.47.0-2+b2 | Apache-2.0, BSD-3-Clause, GPL, GPL-2, GPL-2+, ISC, Kazlib, Latex2e, LGPL-2 | not-allowed: not on the permitted list: GPL, GPL-2, GPL-2+, Kazlib, Latex2e, LGPL-2 |
| libgdbm-compat4 | 1.23-3 | GFDL-NIV-1.3+, GPL-2+, GPL-3+ | not-allowed: not on the permitted list: GFDL-NIV-1.3+, GPL-2+, GPL-3+ |
| libgdbm6 | 1.23-3 | GFDL-NIV-1.3+, GPL-2+, GPL-3+ | not-allowed: not on the permitted list: GFDL-NIV-1.3+, GPL-2+, GPL-3+ |
| libgnutls30 | 3.7.9-2+deb12u7 | , Apache-2.0, BSD-3-Clause, CC0, MIT, GPLv3+, LGPLv2.1+, LGPLv3+_or_GPLv2+, The | not-allowed: not on the permitted list: , CC0, GPLv3+, LGPLv2.1+, LGPLv3+_or_GPLv2+, The |
| libhogweed6 | 3.8.1-2 | MIT, GAP, GPL-2, GPL-2+, GPL-3+, LGPL-2+, LGPL-3+, public-domain | not-allowed: not on the permitted list: GAP, GPL-2, GPL-2+, GPL-3+, LGPL-2+, LGPL-3+, public-domain |
| libicu72 | 72.1-3+deb12u1 | GPL-3, MIT | not-allowed: not on the permitted list: GPL-3 |
| libldap-2.5-0 | 2.5.13+dfsg-5 | Beerware, BSD-3-Clause, BSD-3-clause-California, BSD-3-clause-variant, BSD-4-clause-California, MIT, Expat-ISC, Expat-UNM, F5, FSF-unlimited, GPL-2+, GPL-3+, JCG, MIT-XC, NeoSoft-permissive, OpenLDAP-2.8, public-domain, UMich | not-allowed: not on the permitted list: Beerware, BSD-3-clause-California, BSD-3-clause-variant, BSD-4-clause-California, Expat-ISC, Expat-UNM, F5, FSF-unlimited, GPL-2+, GPL-3+, JCG, MIT-XC, NeoSoft-permissive, OpenLDAP-2.8, public-domain, UMich |
| libnettle8 | 3.8.1-2 | MIT, GAP, GPL-2, GPL-2+, GPL-3+, LGPL-2+, LGPL-3+, public-domain | not-allowed: not on the permitted list: GAP, GPL-2, GPL-2+, GPL-3+, LGPL-2+, LGPL-3+, public-domain |
| libnpth0 | 1.6-3 | LGPL-2.1+ | not-allowed: not on the permitted list: LGPL-2.1+ |
| libperl5.36 | 5.36.0-7+deb12u3 | Artistic, Artistic-2, Artistic-dist, BSD-3-Clause, BSD-3-clause-GENERIC, BSD-3-clause-with-weird-numbering, BSD-4-clause-POWERDOG, BZIP, CC0-1.0, DONT-CHANGE-THE-GPL, MIT, GPL-1+, GPL-2+, GPL-3+-WITH-BISON-EXCEPTION, HSIEH-BSD, HSIEH-DERIVATIVE, LGPL-2.1, REGCOMP, REGCOMP,, RRA-KEEP-THIS-NOTICE, SDBM-PUBLIC-DOMAIN, TEXT-TABS, Unicode, ZLIB | not-allowed: not on the permitted list: Artistic, Artistic-2, Artistic-dist, BSD-3-clause-GENERIC, BSD-3-clause-with-weird-numbering, BSD-4-clause-POWERDOG, BZIP, DONT-CHANGE-THE-GPL, GPL-1+, GPL-2+, GPL-3+-WITH-BISON-EXCEPTION, HSIEH-BSD, HSIEH-DERIVATIVE, LGPL-2.1, REGCOMP, REGCOMP,, RRA-KEEP-THIS-NOTICE, SDBM-PUBLIC-DOMAIN, TEXT-TABS, Unicode, ZLIB |
| libpython3.11-minimal | 3.11.2-6+deb12u7 | - | no-licence-file: /usr/share/doc/libpython3.11-minimal/copyright is missing |
| libreadline8 | 8.2-1.3 | GFDL-NIV-1.3+, GPL-2+, GPL-3, GPL-3+, ISC-no-attribution | not-allowed: not on the permitted list: GFDL-NIV-1.3+, GPL-2+, GPL-3, GPL-3+, ISC-no-attribution |
| libss2 | 1.47.0-2+b2 | Apache-2.0, BSD-3-Clause, GPL, GPL-2, GPL-2+, ISC, Kazlib, Latex2e, LGPL-2 | not-allowed: not on the permitted list: GPL, GPL-2, GPL-2+, Kazlib, Latex2e, LGPL-2 |
| libssl3 | 3.0.20-1~deb12u2 | Apache-2.0, Artistic, GPL-1+ | not-allowed: not on the permitted list: Artistic, GPL-1+ |
| libtirpc-common | 1.3.3+ds-1 | - | no-licence-file: /usr/share/doc/libtirpc-common/copyright is missing |
| libunistring2 | 1.0-2 | FreeSoftware, GFDL-1.2+, GPL-2+, GPL-3+, LGPL-3+, MIT | not-allowed: not on the permitted list: FreeSoftware, GFDL-1.2+, GPL-2+, GPL-3+, LGPL-3+ |
| logsave | 1.47.0-2+b2 | Apache-2.0, BSD-3-Clause, GPL, GPL-2, GPL-2+, ISC, Kazlib, Latex2e, LGPL-2 | not-allowed: not on the permitted list: GPL, GPL-2, GPL-2+, Kazlib, Latex2e, LGPL-2 |
| media-types | 10.0.0 | - | no-licence-file: /usr/share/doc/media-types/copyright is missing |
| perl-modules-5.36 | 5.36.0-7+deb12u3 | Artistic, Artistic-2, Artistic-dist, BSD-3-Clause, BSD-3-clause-GENERIC, BSD-3-clause-with-weird-numbering, BSD-4-clause-POWERDOG, BZIP, CC0-1.0, DONT-CHANGE-THE-GPL, MIT, GPL-1+, GPL-2+, GPL-3+-WITH-BISON-EXCEPTION, HSIEH-BSD, HSIEH-DERIVATIVE, LGPL-2.1, REGCOMP, REGCOMP,, RRA-KEEP-THIS-NOTICE, SDBM-PUBLIC-DOMAIN, TEXT-TABS, Unicode, ZLIB | not-allowed: not on the permitted list: Artistic, Artistic-2, Artistic-dist, BSD-3-clause-GENERIC, BSD-3-clause-with-weird-numbering, BSD-4-clause-POWERDOG, BZIP, DONT-CHANGE-THE-GPL, GPL-1+, GPL-2+, GPL-3+-WITH-BISON-EXCEPTION, HSIEH-BSD, HSIEH-DERIVATIVE, LGPL-2.1, REGCOMP, REGCOMP,, RRA-KEEP-THIS-NOTICE, SDBM-PUBLIC-DOMAIN, TEXT-TABS, Unicode, ZLIB |
| python3 | 3.11.2-1+b1 | - | no-licence-file: /usr/share/doc/python3/copyright is missing |
| python3.11-minimal | 3.11.2-6+deb12u7 | - | no-licence-file: /usr/share/doc/python3.11-minimal/copyright is missing |
| usr-is-merged | 37~deb12u1 | GPL-2+ | not-allowed: not on the permitted list: GPL-2+ |
| util-linux-extra | 2.38.1-5+deb12u3 | BSD-3-Clause, BSD-4-clause, BSLA, GPL-2, GPL-2+, GPL-3+, LGPL, LGPL-2+, LGPL-2.1+, LGPL-3+, MIT, public-domain | not-allowed: not on the permitted list: BSD-4-clause, BSLA, GPL-2, GPL-2+, GPL-3+, LGPL, LGPL-2+, LGPL-2.1+, LGPL-3+, public-domain |
