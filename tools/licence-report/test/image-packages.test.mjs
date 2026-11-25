import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { COLLECT, addedPackages, evaluate, imageFromCompose, normaliseLicence, parseList, report } from "../image-packages.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "image-packages.mjs");

// The fixtures are written to a scratch folder inside this one (the system temp directory may be full) and removed afterwards.
// A package list is what the collecting script prints in an image: name, version and the `License:` names of its copyright file, tab separated; `-` is no copyright file.
const OLD = ["libc6\t2.36-9\tGPL-2|LGPL-2.1", "tzdata\t2024a\tPublic-Domain", "zlib1g\t1.2.13\tZlib"].join("\n");
const NEW = ["libc6\t2.36-9\tGPL-2|LGPL-2.1", "tzdata\t2024a\tPublic-Domain", "zlib1g\t1.2.13\tZlib", "postgresql-17-pgvector\t0.8.5-1\tPostgreSQL", "libfoo\t1.0\tExpat|BSD-3-clause"].join("\n");

test("the collecting script fails when dpkg-query does, instead of printing an empty list (a pipeline hides the status of its first command)", () => {
  assert.match(COLLECT, /^out=\$\(dpkg-query [^)]*\) \|\| exit 1;/);
  assert.ok(!/^dpkg-query[^;]*\|/.test(COLLECT));
});

test("a copyright file is looked for under the package, then under its source package, then wherever dpkg put one", () => {
  assert.ok(COLLECT.includes("$p"));
  assert.ok(COLLECT.includes("source:Package"));
  assert.ok(COLLECT.includes("dpkg -L"));
});

test("the collecting script asks dpkg for plain fields (an escaped dollar printed the field name with a dollar in front of it in CI)", () => {
  assert.ok(COLLECT.includes("-f='${Package}\\t${Version}\\t${source:Package}\\n'"));
  assert.ok(!COLLECT.includes("\\$"));
});

test("a list is parsed per package, and a malformed line is an error, not skipped", () => {
  assert.deepEqual(parseList("a\t1\tMIT|ISC\nb\t2\t-\nc\t3\t"), [
    { name: "a", version: "1", licences: ["MIT", "ISC"] },
    { name: "b", version: "2", licences: null },
    { name: "c", version: "3", licences: [] },
  ]);
  assert.throws(() => parseList("only-a-name"), /malformed/);
});

test("the difference is the packages of the new image that the old one does not have (by name; a new version of a package is not an addition)", () => {
  assert.deepEqual(addedPackages(parseList(OLD), parseList(NEW)).map((p) => p.name), ["postgresql-17-pgvector", "libfoo"]);
  assert.deepEqual(addedPackages(parseList(NEW), parseList(OLD)), []);
  assert.deepEqual(addedPackages(parseList(OLD), parseList(OLD.replace("2.36-9", "2.36-10"))), []);
});

test("a compound License value is judged by every name in it: `or` needs one permitted alternative, `and` all of them, and the first word alone never decides", () => {
  const rows = evaluate(parseList(["or\t1\tGPL-2+ or MIT", "and\t1\tMIT and GPL-3", "plain\t1\tMIT", "lgpl\t1\tLGPL-2.1+ or GPL-2+"].join("\n")));
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["or", "allowed"], ["and", "not-allowed"], ["plain", "allowed"], ["lgpl", "not-allowed"]]);
  assert.match(rows[1].detail, /GPL-3/);
});

test("Debian's lower-case public-domain is the public-domain of the permitted list", () => {
  assert.equal(normaliseLicence("public-domain"), "Public-Domain");
  assert.equal(evaluate(parseList("p\t1\tpublic-domain"))[0].status, "allowed");
});

test("Debian's names of licences are read as the ones of the permitted list", () => {
  assert.equal(normaliseLicence("Expat"), "MIT");
  assert.equal(normaliseLicence("BSD-3-clause"), "BSD-3-Clause");
  assert.equal(normaliseLicence("Apache-2"), "Apache-2.0");
  assert.equal(normaliseLicence("PostgreSQL"), "PostgreSQL");
  assert.equal(normaliseLicence("GPL-3+"), "GPL-3+");
});

test("an added package passes on permitted licences, is recorded with an owner exception, and otherwise fails by its reason", () => {
  const added = parseList(["ok\t1\tMIT|Expat", "gpl\t1\tGPL-3+", "nofile\t1\t-", "noname\t1\t", "excepted\t1\tGPL-2"].join("\n"));
  const rows = evaluate(added, [{ package: "excepted", owner: "o", reason: "base image of the database" }]);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["ok", "allowed"], ["gpl", "not-allowed"], ["nofile", "no-licence-file"], ["noname", "unparsable"], ["excepted", "exception"]]);
  assert.match(rows[1].detail, /GPL-3\+/);
  assert.equal(rows[4].detail, "base image of the database (owner o)");
});

test("an exception without an owner or a reason does not count", () => {
  const rows = evaluate(parseList("p\t1\tGPL-2"), [{ package: "p", reason: "because" }]);
  assert.equal(rows[0].status, "not-allowed");
});

test("the report lists every added package with its licence, and names what the owner has to decide", () => {
  const text = report({ oldImage: "old", newImage: "new", rows: evaluate(addedPackages(parseList(OLD), parseList(NEW)), []) });
  assert.match(text, /postgresql-17-pgvector.*PostgreSQL/);
  assert.match(text, /libfoo.*MIT.*BSD-3-Clause/);
  assert.match(text, /old/);
  assert.match(text, /new/);
});

function cli(old, neu, extra = []) {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "work-"));
  try {
    writeFileSync(join(dir, "old.tsv"), old);
    writeFileSync(join(dir, "new.tsv"), neu);
    const r = spawnSync(process.execPath, [script, "--compare", "old", "new", "--old-list", join(dir, "old.tsv"), "--new-list", join(dir, "new.tsv"), "--out", join(dir, "out.md"), ...extra], { encoding: "utf8" });
    let out = "";
    try { out = readFileSync(join(dir, "out.md"), "utf8"); } catch { /* not written */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the command exits 0 when every added package is permitted, and writes the result", () => {
  const r = cli(OLD, NEW);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.out, /postgresql-17-pgvector/);
});

test("the command exits 1 on an added package with no licence file, one with no licence name, and one that is copyleft", () => {
  for (const line of ["x\t1\t-", "x\t1\t", "x\t1\tGPL-3+"]) {
    const r = cli(OLD, `${NEW}\n${line}`);
    assert.equal(r.status, 1, line);
    assert.match(r.stdout + r.out, /\bx\b/);
  }
});

test("the command exits 2 when an image yields no packages (it must not pass having checked nothing)", () => {
  assert.equal(cli("", NEW).status, 2);
  assert.equal(cli(OLD, "").status, 2);
});

test("an exception from the file passes the package, and a package that is new and not in the file still fails", () => {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "work-"));
  try {
    const file = join(dir, "ex.json");
    writeFileSync(file, JSON.stringify([{ package: "gplpkg", owner: "o", reason: "aggregation" }]));
    assert.equal(cli(OLD, `${NEW}\ngplpkg\t1\tGPL-3+`, ["--exceptions", file]).status, 0);
    assert.equal(cli(OLD, `${NEW}\ngplpkg\t1\tGPL-3+\nother\t1\tGPL-3+`, ["--exceptions", file]).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the report separates what both images have from what the new one adds", () => {
  const text = report({ oldImage: "old", newImage: "new", rows: [], common: 3 });
  assert.match(text, /3 package\(s\) are in both images/);
});

test("the image of a service is read from the resolved Compose JSON, and every way that can fail says what failed", () => {
  const json = JSON.stringify({ services: { postgres: { image: "img@sha256:aa" }, app: {} } });
  assert.equal(imageFromCompose(json, "postgres"), "img@sha256:aa");
  assert.throws(() => imageFromCompose("", "postgres"), /printed nothing/);
  assert.throws(() => imageFromCompose("not json", "postgres"), /not JSON/);
  assert.throws(() => imageFromCompose(json, "missing"), /service "missing"/);
  assert.throws(() => imageFromCompose(json, "app"), /service "app" has no image/);
});

test("a copyright file in free text is read by the licences it names, not as having none", () => {
  const rows = evaluate(parseList(["free\t1\ttext:GNU General Public License", "apache\t1\ttext:Apache License, Version 2.0", "apache1\t1\ttext:Apache License, Version 1.1", "none\t1\t"].join("\n")));
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [["free", "not-allowed"], ["apache", "allowed"], ["apache1", "not-allowed"], ["none", "unparsable"]]);
  assert.match(rows[0].detail, /free text: GNU General Public License/);
});

test("an image that cannot be run is reported by its cause, not by a TypeError (docker not on the path)", () => {
  const r = spawnSync(process.execPath, [script, "--compare", "old-image", "new-image"], { encoding: "utf8", env: { PATH: "" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not list the packages of old-image/);
  assert.doesNotMatch(r.stderr, /TypeError|Cannot read/);
});

test("the command says why it failed, once, when it exits 1", () => {
  const r = cli(OLD, `${NEW}\nbad\t1\tGPL-3+`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1 package\(s\) fail the audit: bad \(not-allowed\)/);
});

test("the command exits 2, saying what it could not run, when Compose cannot be run (no docker on the path: nothing is started here)", () => {
  const r = spawnSync(process.execPath, [script, "--compare", "old", "--new-from-compose", "compose.yaml", "--old-list", "/dev/null"], { encoding: "utf8", env: { PATH: "" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not run `docker compose`/);
});

test("the command exits 2 on a missing argument", () => {
  assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 2);
});
