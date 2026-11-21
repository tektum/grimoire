// The authority for which licences shipped code may use (R12.25, owner decision Q27 answer A; Q19, Q20, Q23).
// Rule: ANY OSI-approved PERMISSIVE licence (no copyleft or share-alike condition on our own code) plus public-domain
// dedications; NO copyleft in shipped code, weak copyleft included. Development-only tools may additionally use MPL-2.0.
// This is an enumerated list, not a run-time judgement: a licence not listed here is refused.
// Sources, fetched 2026-11-20 and treated as data: SPDX license-list-data v3.28-era release 2026-11-18
// (https://github.com/spdx/license-list-data, `isOsiApproved` flag, which mirrors the OSI approved-licence list;
// the OSI API https://api.opensource.org/licenses/ returned no usable data that day) and the OSI list
// (https://opensource.org/licenses). Every entry is `osi: true` except the public-domain dedication CC0-1.0 (decision Q23). BSD-3-Clause-Clear and PSF-2.0 are permissive but not OSI-approved: they need an owner exception.
// Refused on purpose (tested): GPL, LGPL, AGPL, MPL (shipped), EPL, CDDL, EUPL, CC-BY-SA, CC-BY-NC, WTFPL (not
// OSI-approved), BUSL-1.1 (Business Source Licence), SSPL, Elastic, "SEE LICENSE", UNLICENSED (means no licence).
// Undecided, left out: Artistic-2.0 (no citation that it is free of copyleft-style conditions on modified versions).

export const SHIPPED_LICENCES = [
  { id: "MIT", family: "MIT", osi: true },
  { id: "MIT-0", family: "MIT", osi: true },
  { id: "Apache-2.0", family: "Apache", osi: true },
  { id: "BSD-2-Clause", family: "BSD", osi: true },
  { id: "BSD-3-Clause", family: "BSD", osi: true },
  { id: "ISC", family: "ISC", osi: true },
  { id: "0BSD", family: "BSD", osi: true, note: "decision Q20" },
  { id: "BlueOak-1.0.0", family: "BlueOak", osi: true, note: "decision Q19" },
  { id: "Zlib", family: "Zlib", osi: true },
  { id: "Unlicense", family: "PublicDomain", osi: true, note: "not UNLICENSED, which means no licence and is refused" },
  { id: "Python-2.0", family: "Python", osi: true },
  { id: "PostgreSQL", family: "PostgreSQL", osi: true },
  { id: "NCSA", family: "BSD", osi: true },
  { id: "UPL-1.0", family: "UPL", osi: true },
  { id: "BSL-1.0", family: "Boost", osi: true, note: "Boost, not the Business Source Licence (BUSL-1.1, refused)" },
  { id: "CC0-1.0", family: "PublicDomain", osi: false, note: "public-domain dedication; decision Q23" },
  { id: "OFL-1.1", family: "Font", osi: true, note: "fonts only: modified fonts stay OFL and a font may not be sold by itself; no condition on our code. The tool cannot restrict by package kind, so this is a review note" },
];

export const DEV_ONLY_EXTRA = [{ id: "MPL-2.0", family: "MPL", osi: true, note: "development-only tools (decision Q19)" }];
