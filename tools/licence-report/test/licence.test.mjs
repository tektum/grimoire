import { test } from "node:test";
import assert from "node:assert/strict";
import { validateImagesText, validateExceptions, validatePending, normaliseLicenceField, judgeLicence, classifyGraph, checkLock, findException, versionInRange, parseExpression } from "../licence.mjs";

// Build a lockfile fixture. pkgs: name -> {licence, deps, optional}; ws: workspace key -> {dependencies, devDependencies}
function lock(ws, pkgs) {
  const packages = { "": { name: "root", devDependencies: ws.root ?? {} } };
  for (const [dir, w] of Object.entries(ws.workspaces ?? {})) {
    packages[dir] = { name: `@x/${dir}`, ...w };
    packages[`node_modules/@x/${dir}`] = { resolved: dir, link: true };
  }
  for (const [name, p] of Object.entries(pkgs)) {
    packages[`node_modules/${name}`] = { version: "1.0.0", license: p.licence, dependencies: p.deps, optional: p.optional };
  }
  return { lockfileVersion: 3, packages };
}
const meta = (l) => (key) => (l.packages[key].optional ? null : { name: key.replace("node_modules/", ""), version: "1.0.0", license: l.packages[key].license });
const run = (l, exceptions = []) => checkLock(l, { readMeta: meta(l), exceptions });

test("allowed and refused licences per class", () => {
  for (const id of ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "BlueOak-1.0.0", "0BSD"]) {
    assert.ok(judgeLicence(id, "shipped").ok, id);
    assert.ok(judgeLicence(id, "dev").ok, id);
  }
  assert.equal(judgeLicence("MPL-2.0", "shipped").ok, false);
  assert.equal(judgeLicence("MPL-2.0", "dev").ok, true);
  for (const id of ["AGPL-3.0", "GPL-3.0-only", "EPL-2.0", "EPL-2.0", "UNLICENSED"]) {
    assert.equal(judgeLicence(id, "shipped").ok, false, id);
    assert.equal(judgeLicence(id, "dev").ok, false, id);
  }
});

test("dual licences pass when one option is allowed for the class", () => {
  assert.ok(judgeLicence("(MIT OR GPL-3.0)", "shipped").ok);
  assert.ok(judgeLicence("(GPL-3.0 OR MPL-2.0)", "dev").ok);
  assert.equal(judgeLicence("(GPL-3.0 OR MPL-2.0)", "shipped").ok, false);
  assert.equal(judgeLicence("MIT AND GPL-3.0", "shipped").ok, false);
  assert.ok(judgeLicence("MIT AND ISC", "shipped").ok);
  assert.equal(judgeLicence("(GPL-3.0 OR AGPL-3.0)", "dev").ok, false);
});

test("missing and unparseable licences fail", () => {
  assert.match(judgeLicence(undefined, "dev").reason, /missing/);
  assert.match(judgeLicence("", "dev").reason, /missing/);
  assert.match(judgeLicence("MIT OR", "dev").reason, /unparseable/);
  assert.match(judgeLicence("(MIT", "dev").reason, /unparseable/);
  assert.match(judgeLicence("SEE LICENSE IN LICENSE.md", "dev").reason, /unparseable/);
  assert.equal(parseExpression("MIT WITH"), null);
  assert.equal(judgeLicence("MIT WITH Classpath-exception-2.0", "shipped").ok, false);
});

test("classification: dev-only vs shipped, through transitive edges", () => {
  const l = lock(
    { root: { devtool: "1" }, workspaces: { app: { dependencies: { prod: "1" }, devDependencies: { devtool: "1" } } } },
    { prod: { licence: "MIT", deps: { sub: "1" } }, sub: { licence: "MIT" }, devtool: { licence: "MPL-2.0", deps: { sub2: "1" } }, sub2: { licence: "MPL-2.0" } },
  );
  const c = classifyGraph(l);
  assert.equal(c.get("node_modules/prod").class, "shipped");
  assert.equal(c.get("node_modules/sub").class, "shipped");
  assert.equal(c.get("node_modules/devtool").class, "dev");
  assert.deepEqual(c.get("node_modules/sub2").path, ["(root)", "devtool", "sub2"]);
  assert.equal(run(l).violations.length, 0);
});

test("MPL-2.0 reached through a devDependency and a production dependency is shipped and fails", () => {
  const l = lock(
    { root: { devtool: "1" }, workspaces: { app: { dependencies: { prod: "1" } } } },
    { prod: { licence: "MIT", deps: { mpl: "1" } }, devtool: { licence: "MIT", deps: { mpl: "1" } }, mpl: { licence: "MPL-2.0" } },
  );
  const r = run(l);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].name, "mpl");
  assert.equal(r.violations[0].class, "shipped");
  assert.deepEqual(r.violations[0].path, ["app", "prod", "mpl"]);
});

test("disallowed licence in a dev-only package fails with its path", () => {
  const l = lock({ root: { devtool: "1" } }, { devtool: { licence: "MIT", deps: { bad: "1" } }, bad: { licence: "AGPL-3.0" } });
  const r = run(l);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].class, "dev");
  assert.deepEqual(r.violations[0].path, ["(root)", "devtool", "bad"]);
});

test("missing licence field fails", () => {
  const l = lock({ root: { a: "1" } }, { a: { licence: undefined } });
  assert.match(run(l).violations[0].reason, /missing/);
});

test("exceptions: match passes, version mismatch and licence mismatch fail", () => {
  const ex = { name: "bad", versions: ">=1.0.0 <2.0.0", licence: "AGPL-3.0", reason: "r", source: "s", approvedBy: "o" };
  const l = lock({ root: { bad: "1" } }, { bad: { licence: "AGPL-3.0" } });
  const ok = run(l, [ex]);
  assert.equal(ok.violations.length, 0);
  assert.equal(ok.packages[0].exception.approvedBy, "o");
  assert.equal(run(l, [{ ...ex, versions: ">=2.0.0" }]).violations.length, 1);
  assert.equal(run(l, [{ ...ex, versions: "1.0.1" }]).violations.length, 1);
  assert.equal(run(l, [{ ...ex, licence: "GPL-3.0" }]).violations.length, 1);
  assert.equal(run(l, [{ ...ex, name: "other" }]).violations.length, 1);
  assert.ok(findException([ex], "bad", "1.5.0", "AGPL-3.0"));
  assert.equal(findException([ex], "bad", "2.0.0", "AGPL-3.0"), null);
});

test("version ranges", () => {
  assert.ok(versionInRange("1.2.3", "*"));
  assert.ok(versionInRange("1.2.3", "1.2.3"));
  assert.ok(!versionInRange("1.2.4", "1.2.3"));
  assert.ok(versionInRange("17.2.0", ">=17 <18"));
  assert.ok(!versionInRange("18.0.0", ">=17 <18"));
});

test("private workspace packages are excluded", () => {
  const l = lock({ workspaces: { app: { dependencies: {} } } }, {});
  l.packages["app"].license = "UNLICENSED";
  const r = run(l);
  assert.equal(r.packages.length, 0);
  assert.equal(r.violations.length, 0);
});

test("optional package that is not installed is checked with the lockfile licence", () => {
  const bad = lock({ root: { bin: "1" } }, { bin: { licence: "AGPL-3.0", optional: true } });
  const r = run(bad);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].name, "bin");
  assert.equal(r.packages[0].installed, false);
  assert.equal(run(lock({ root: { bin: "1" } }, { bin: { licence: "MPL-2.0", optional: true } })).violations.length, 0);
  assert.equal(run(lock({ workspaces: { app: { dependencies: { bin: "1" } } } }, { bin: { licence: "MPL-2.0", optional: true } })).violations.length, 1);
});

test("a not-installed package that is not recorded fails and is named", () => {
  const r = run(lock({ root: { bin: "1" } }, { bin: { licence: undefined, optional: true } }));
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0].reason, /not recorded in lock-licences\.json.*record-licences/);
  assert.equal(r.violations[0].name, "bin");
});

test("SEE LICENSE IN, UNLICENSED and the deprecated licenses array", () => {
  assert.equal(judgeLicence("SEE LICENSE IN LICENSE.txt", "dev").ok, false);
  assert.equal(judgeLicence("UNLICENSED", "dev").ok, false);
  assert.equal(normaliseLicenceField({ licenses: [{ type: "MIT" }, { type: "GPL-3.0" }] }), "(MIT OR GPL-3.0)");
  assert.ok(judgeLicence(normaliseLicenceField({ licenses: [{ type: "MIT" }, { type: "GPL-3.0" }] }), "shipped").ok);
  assert.equal(judgeLicence(normaliseLicenceField({ licenses: [{ type: "GPL-3.0" }] }), "shipped").ok, false);
  assert.equal(normaliseLicenceField({ license: { type: "ISC" } }), "ISC");
  assert.equal(normaliseLicenceField({ licenses: [] }), null);
});

const goodEx = { name: "p", versions: "*", licence: "X", reason: "r", source: "s", approvedBy: "o", expires: "2027-01-01" };
test("exception validation: empty or missing fields, bad and expired dates, unknown fields", () => {
  assert.deepEqual(validateExceptions([goodEx], "2026-11-20"), []);
  for (const f of ["name", "versions", "licence", "reason", "source", "approvedBy", "expires"]) {
    const missing = { ...goodEx };
    delete missing[f];
    assert.match(validateExceptions([missing], "2026-11-20").join("\n"), new RegExp(`"${f}" is missing`));
    assert.match(validateExceptions([{ ...goodEx, [f]: "  " }], "2026-11-20").join("\n"), new RegExp(`"${f}" is missing`));
  }
  assert.match(validateExceptions([{ ...goodEx, expires: "2026-11-19" }], "2026-11-20")[0], /expired on 2026-11-19/);
  assert.deepEqual(validateExceptions([{ ...goodEx, expires: "2026-11-20" }], "2026-11-20"), []);
  assert.match(validateExceptions([{ ...goodEx, expires: "next year" }], "2026-11-20")[0], /ISO date/);
  assert.match(validateExceptions([{ ...goodEx, extra: 1 }], "2026-11-20")[0], /unknown field "extra"/);
  assert.match(validateExceptions({}, "2026-11-20")[0], /JSON array/);
});

test("pending items are reported separately from violations; unmatched ones are returned", () => {
  const l = lock({ workspaces: { app: { dependencies: { z: "1" } } } }, { z: { licence: "EPL-2.0" } });
  const pend = [
    { name: "z", version: "1.0.0", licence: "EPL-2.0", question: "Q99", date: "2026-11-20" },
    { name: "gone", version: "1.0.0", licence: "EPL-2.0", question: "Q98", date: "2026-11-20" },
  ];
  const r = checkLock(l, { readMeta: meta(l), pending: pend });
  assert.equal(r.violations.length, 0);
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].pending.question, "Q99");
  assert.equal(r.unusedPending[0].name, "gone");
  const wrongVersion = checkLock(l, { readMeta: meta(l), pending: [{ ...pend[0], version: "2.0.0" }] });
  assert.equal(wrongVersion.violations.length, 1);
  assert.deepEqual(validatePending([{ name: "a" }]).length > 0, true);
});

test("duplicate exceptions: identical and overlapping ranges fail; disjoint ranges are allowed", () => {
  const e = (versions, over = {}) => ({ ...goodEx, versions, ...over });
  const msg = (list) => validateExceptions(list, "2026-11-20").join("\n");
  assert.match(msg([e("1.0.0"), e("1.0.0")]), /duplicate exceptions \[0\] and \[1\] for p/);
  assert.match(msg([e(">=1.0.0 <2.0.0"), e(">=1.5.0 <3.0.0")]), /overlap/);
  assert.match(msg([e("*"), e("2.0.0")]), /overlap/);
  assert.match(msg([e(">=1.0.0 <2.0.0"), e("1.2.0")]), /overlap/);
  assert.equal(msg([e(">=1.0.0 <2.0.0"), e(">=2.0.0 <3.0.0")]), "");
  assert.equal(msg([e("1.0.0"), e("1.0.1")]), "");
  assert.equal(msg([e("1.0.0"), e("1.0.0", { licence: "Y" })]), "");
  assert.equal(msg([e("1.0.0"), e("1.0.0", { name: "q" })]), "");
});

test("duplicate pending items fail; different versions are allowed", () => {
  const p = (version, name = "a") => ({ name, version, licence: "EPL-2.0", question: "Q", date: "2026-11-20" });
  assert.match(validatePending([p("1.0.0"), p("1.0.0")]).join("\n"), /duplicate items \[0\] and \[1\] for a@1\.0\.0/);
  assert.deepEqual(validatePending([p("1.0.0"), p("1.0.1"), p("1.0.0", "b")]), []);
});

test("an image listed twice in images.json fails", () => {
  const dup = '{"postgres":{"licence":"X","source":"s","tags":["17"]},"postgres":{"licence":"X","source":"s","tags":["18"]}}';
  assert.match(validateImagesText(dup)[0], /image "postgres" is listed twice/);
  assert.match(validateImagesText('{"postgres":{},"docker.io/library/postgres":{}}')[0], /listed twice/);
  assert.deepEqual(validateImagesText('{"postgres":{"tags":["postgres"]},"chrislusf/seaweedfs":{}}'), []);
});

test("0BSD is allowed for shipped and development packages, alone and in compound expressions", () => {
  assert.ok(judgeLicence("0BSD", "shipped").ok);
  assert.ok(judgeLicence("(0BSD OR GPL-3.0)", "shipped").ok);
  assert.ok(judgeLicence("0BSD AND MIT", "shipped").ok);
  assert.equal(judgeLicence("0BSD AND GPL-3.0", "shipped").ok, false);
  assert.equal(judgeLicence("0BSD AND MPL-2.0", "shipped").ok, false);
  assert.ok(judgeLicence("0BSD AND MPL-2.0", "dev").ok);
  const l = lock({ workspaces: { app: { dependencies: { tsl: "1" } } } }, { tsl: { licence: "0BSD" } });
  assert.equal(run(l).violations.length, 0);
  assert.equal(run(lock({ workspaces: { app: { dependencies: { tsl: "1" } } } }, { tsl: { licence: "EPL-2.0" } })).violations.length, 1);
});

test("CC0-1.0 is allowed for shipped and development packages, alone and in compound expressions", () => {
  assert.ok(judgeLicence("CC0-1.0", "shipped").ok);
  assert.ok(judgeLicence("CC0-1.0", "dev").ok);
  assert.ok(judgeLicence("(CC0-1.0 OR GPL-3.0)", "shipped").ok);
  assert.ok(judgeLicence("(MIT OR CC0-1.0)", "shipped").ok);
  assert.equal(judgeLicence("CC0-1.0 AND GPL-3.0", "shipped").ok, false);
  assert.equal(judgeLicence("CC-BY-3.0", "dev").ok, false);
});

import { SHIPPED_LICENCES } from "../allowed-licences.mjs";

test("every enumerated licence is allowed for shipped and development packages", () => {
  const want = "MIT MIT-0 Apache-2.0 BSD-2-Clause BSD-3-Clause ISC 0BSD BlueOak-1.0.0 Zlib Unlicense Python-2.0 PostgreSQL NCSA UPL-1.0 BSL-1.0 CC0-1.0 OFL-1.1".split(" ");
  assert.deepEqual(SHIPPED_LICENCES.map((l) => l.id).sort(), [...want].sort());
  for (const id of want) {
    assert.ok(judgeLicence(id, "shipped").ok, id);
    assert.ok(judgeLicence(id, "dev").ok, id);
  }
  assert.ok(SHIPPED_LICENCES.every((l) => l.family));
});

test("copyleft and unlisted families are refused everywhere (MPL-2.0 only for dev)", () => {
  const refused = [
    "GPL-2.0-only", "GPL-3.0-or-later", "LGPL-2.1-only", "LGPL-3.0-or-later", "AGPL-3.0-only", "EPL-2.0", "CDDL-1.0",
    "EUPL-1.2", "CC-BY-SA-4.0", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "WTFPL", "BUSL-1.1", "SSPL-1.0", "Elastic-2.0",
    "SEE LICENSE IN LICENSE.md", "UNLICENSED", "Artistic-2.0", "CC-BY-3.0", "unlicense", "UNLICENSE", "mit",
    // permissive but not OSI-approved: needs an owner exception
    "BSD-3-Clause-Clear", "PSF-2.0",
  ];
  for (const id of refused) {
    assert.equal(judgeLicence(id, "shipped").ok, false, `${id} shipped`);
    assert.equal(judgeLicence(id, "dev").ok, false, `${id} dev`);
  }
  assert.equal(judgeLicence("MPL-2.0", "shipped").ok, false);
  assert.ok(judgeLicence("MPL-2.0", "dev").ok);
});

test("compound expressions with the new licences keep OR/AND semantics", () => {
  assert.ok(judgeLicence("(Unlicense OR GPL-3.0)", "shipped").ok);
  assert.ok(judgeLicence("(LGPL-3.0 OR Zlib)", "shipped").ok);
  assert.equal(judgeLicence("(LGPL-3.0 OR GPL-3.0)", "shipped").ok, false);
  assert.ok(judgeLicence("MIT AND Zlib", "shipped").ok);
  assert.equal(judgeLicence("MIT AND LGPL-3.0", "shipped").ok, false);
  assert.ok(judgeLicence("(MIT OR CC0-1.0)", "shipped").ok);
});

test("allow-list invariant: every entry is OSI-approved except the CC0-1.0 public-domain dedication", () => {
  for (const l of SHIPPED_LICENCES) assert.equal(l.osi, l.id === "CC0-1.0" ? false : true, l.id);
  assert.ok(SHIPPED_LICENCES.some((l) => l.id === "CC0-1.0"));
});

test("a prerelease never matches an exception for its release, unless the range names it exactly", () => {
  assert.equal(versionInRange("1.0.0-rc.1", "1.0.0"), false);
  assert.equal(versionInRange("1.0.0-rc.1", ">=1.0.0"), false);
  assert.equal(versionInRange("1.0.0-rc.1", "*"), true);
  assert.equal(versionInRange("1.0.0-rc.1", "1.0.0-rc.1"), true);
  assert.equal(versionInRange("1.0.0+build5", "1.0.0"), true);
  const ex = [{ name: "p", versions: "1.0.0", licence: "GPL-3.0-only", reason: "r" }];
  assert.equal(findException(ex, "p", "1.0.0-rc.1", "GPL-3.0-only"), null);
  assert.ok(findException(ex, "p", "1.0.0", "GPL-3.0-only"));
});

test("a lock that is not the npm-style map (bun.lock tuples as packages) is refused, not read as empty", () => {
  const raw = { packages: { "@a/b": ["@a/b@1.0.0", "", {}, "sha512-x"] } };
  assert.throws(() => checkLock(raw, { readMeta: () => null }), /not the npm-style map.*bunLockToPackages/);
});
