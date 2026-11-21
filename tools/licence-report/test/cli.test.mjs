import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const runMjs = join(dirname(fileURLToPath(import.meta.url)), "..", "run.mjs");

function fixture({ pkgs, workspaceDeps = {}, rootDev = {}, compose = "services: {}\n", exceptions = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "licence-fixture-"));
  const workspaces = { "": { name: "fx", devDependencies: rootDev }, "packages/app": { name: "app", dependencies: workspaceDeps } };
  const packages = { app: ["app@workspace:packages/app"] };
  for (const [name, licence] of Object.entries(pkgs)) {
    packages[name] = [`${name}@1.0.0`, "", {}, "sha512-fixture"];
    mkdirSync(join(dir, "node_modules", name), { recursive: true });
    writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0", license: licence }));
  }
  writeFileSync(join(dir, "bun.lock"), JSON.stringify({ lockfileVersion: 1, workspaces, packages }));
  writeFileSync(join(dir, "compose.yaml"), compose);
  writeFileSync(join(dir, "licence-exceptions.json"), JSON.stringify(exceptions));
  return dir;
}
const run = (dir, ...extra) =>
  spawnSync(process.execPath, [runMjs, "--root", dir, "--out", join(dir, "out"), ...extra], { encoding: "utf8" });

test("a package with licence AGPL-3.0 fails the report and is named", () => {
  const dir = fixture({ pkgs: { "left-pad-agpl": "AGPL-3.0", good: "MIT" }, workspaceDeps: { "left-pad-agpl": "1", good: "1" } });
  try {
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /left-pad-agpl@1\.0\.0/);
    assert.match(r.stderr, /AGPL-3\.0/);
    assert.equal(JSON.parse(readFileSync(join(dir, "out", "licence-report.json"), "utf8")).ok, false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("MPL-2.0 in the shipped class fails, in the development class passes", () => {
  const shipped = fixture({ pkgs: { mpl: "MPL-2.0" }, workspaceDeps: { mpl: "1" } });
  const dev = fixture({ pkgs: { mpl: "MPL-2.0" }, rootDev: { mpl: "1" } });
  try {
    const a = run(shipped);
    assert.equal(a.status, 1);
    assert.match(a.stderr, /mpl@1\.0\.0: .*not allowed for shipped/);
    assert.equal(run(dev).status, 0);
  } finally {
    rmSync(shipped, { recursive: true });
    rmSync(dev, { recursive: true });
  }
});

test("a clean fixture passes and writes the report", () => {
  const dir = fixture({ pkgs: { good: "MIT" }, workspaceDeps: { good: "1" } });
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, "out", "licence-report.json"), "utf8")).packages.length, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("an image absent from images.json fails the image check", () => {
  const dir = fixture({ pkgs: {}, compose: "services:\n  x:\n    image: evil/unknown:1\n" });
  try {
    const r = run(dir, "--check-images");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /evil\/unknown/);
    assert.match(r.stderr, /not in images\.json/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("the real compose file is fully covered by images.json", () => {
  const r = spawnSync(process.execPath, [runMjs, "--check-images"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

const pendingFile = (dir, items) => {
  const f = join(dir, "pending.json");
  writeFileSync(f, JSON.stringify(items));
  return f;
};
const ex = (over = {}) => ({ name: "x", versions: "*", licence: "AGPL-3.0", reason: "r", source: "s", approvedBy: "o", expires: "2999-01-01", ...over });

test("a malformed or expired exception fails the run even when unused", () => {
  const dir = fixture({ pkgs: { good: "MIT" }, workspaceDeps: { good: "1" }, exceptions: [ex({ reason: "" })] });
  const dir2 = fixture({ pkgs: { good: "MIT" }, workspaceDeps: { good: "1" }, exceptions: [ex({ expires: "2020-01-01" })] });
  const dir3 = fixture({ pkgs: { good: "MIT" }, workspaceDeps: { good: "1" }, exceptions: [ex({ source: undefined, approvedBy: "" })] });
  try {
    const a = run(dir);
    assert.equal(a.status, 2);
    assert.match(a.stderr, /"reason" is missing or empty/);
    const b = run(dir2);
    assert.equal(b.status, 2);
    assert.match(b.stderr, /expired on 2020-01-01/);
    const c = run(dir3);
    assert.match(c.stderr, /"source" is missing/);
    assert.match(c.stderr, /"approvedBy" is missing/);
  } finally {
    for (const d of [dir, dir2, dir3]) rmSync(d, { recursive: true });
  }
});

test("an unused exception is a warning, not a failure", () => {
  const dir = fixture({ pkgs: { good: "MIT" }, workspaceDeps: { good: "1" }, exceptions: [ex()] });
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /warning: exception x .* is not used/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a changed image tag that is not pinned in images.json fails", () => {
  const dir = fixture({ pkgs: {}, compose: "services:\n  x:\n    image: postgres:18\n" });
  try {
    const r = run(dir, "--check-images");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /tag "18" of image "postgres" is not pinned/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("pending items fail the strict run and pass with --allow-pending, always with a warning block", () => {
  const dir = fixture({ pkgs: { tsl: "EPL-2.0" }, workspaceDeps: { tsl: "1" } });
  try {
    const p = pendingFile(dir, [{ name: "tsl", version: "1.0.0", licence: "EPL-2.0", question: "Q99", date: "2026-11-20" }]);
    const strict = run(dir, "--pending", p);
    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /AWAITING AN OWNER DECISION[\s\S]*tsl@1\.0\.0.*Q99/);
    const lax = run(dir, "--pending", p, "--allow-pending");
    assert.equal(lax.status, 0, lax.stderr);
    assert.match(lax.stderr, /AWAITING AN OWNER DECISION/);
    assert.equal(run(dir, "--pending", pendingFile(dir, []), "--allow-pending").status, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("MPL-2.0 reached through both a production and a development dependency fails as shipped", () => {
  const dir = fixture({ pkgs: { mpl: "MPL-2.0" }, workspaceDeps: { mpl: "1" }, rootDev: { mpl: "1" } });
  try {
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mpl@1\.0\.0.*\[shipped\]/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("duplicate exception entries fail the run naming both entries, even when unused", () => {
  const dir = fixture({ pkgs: { good: "MIT" }, workspaceDeps: { good: "1" }, exceptions: [ex(), ex({ versions: ">=1.0.0" })] });
  try {
    const r = run(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /duplicate exceptions \[0\] and \[1\] for x/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a Dockerfile with an unreviewed base image fails even when there is no compose file", () => {
  const dir = fixture({ pkgs: { good: "MIT" }, workspaceDeps: { good: "1" } });
  try {
    rmSync(join(dir, "compose.yaml"));
    writeFileSync(join(dir, "Dockerfile"), "FROM unreviewed/base:1.2.3\n");
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unreviewed\/base/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
