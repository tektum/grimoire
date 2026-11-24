import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { addedPackages, evaluate, normaliseLicence, parseList, report } from "../image-packages.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "image-packages.mjs");

// The fixtures are written to a scratch folder inside this one (the system temp directory may be full) and removed afterwards.
// A package list is what the collecting script prints in an image: name, version and the `License:` names of its copyright file, tab separated; `-` is no copyright file.
const OLD = ["libc6\t2.36-9\tGPL-2|LGPL-2.1", "tzdata\t2024a\tPublic-Domain", "zlib1g\t1.2.13\tZlib"].join("\n");
const NEW = ["libc6\t2.36-9\tGPL-2|LGPL-2.1", "tzdata\t2024a\tPublic-Domain", "zlib1g\t1.2.13\tZlib", "postgresql-17-pgvector\t0.8.5-1\tPostgreSQL", "libfoo\t1.0\tExpat|BSD-3-clause"].join("\n");

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

test("the command exits 2 on a missing argument", () => {
  assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 2);
});
