import assert from "node:assert/strict";
import { test } from "node:test";
import { findDockerfiles } from "../find-dockerfiles.mjs";

// The scan walks the whole repository, and a directory can go while it is being listed (the tests of this folder make and remove scratch directories inside it, in other processes of the same run): that is
// a directory with nothing in it, not a failure of the scan.
const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
const entry = (name, dir) => ({ name, isDirectory: () => dir });

const tree = {
  "/r": [entry("Dockerfile", false), entry("sub", true), entry("gone", true), entry("node_modules", true)],
  "/r/sub": [entry("Dockerfile.dev", false), entry("notes.md", false)],
};
const fs = (overrides = {}) => ({
  readdirSync: (dir) => {
    if (dir === "/r/gone") throw enoent();
    if (!(dir in tree)) throw new Error(`unexpected ${dir}`);
    return tree[dir];
  },
  readFileSync: (path) => {
    if (path === "/r/sub/Dockerfile.dev" && overrides.vanishingFile) throw enoent();
    return `text of ${path}`;
  },
});
const join = (a, b) => `${a}/${b}`;
const relative = (_root, p) => p.slice("/r/".length);

test("finds every Dockerfile, and treats a directory that vanished while it was listed as empty", () => {
  const found = findDockerfiles("/r", { root: "/r", fs: fs(), join, relative });
  assert.deepEqual(found.map((f) => f.name).sort(), ["Dockerfile", "sub/Dockerfile.dev"]);
});

test("treats a Dockerfile that vanished while it was read as not there", () => {
  const found = findDockerfiles("/r", { root: "/r", fs: fs({ vanishingFile: true }), join, relative });
  assert.deepEqual(found.map((f) => f.name), ["Dockerfile"]);
});

test("still fails on any other error: only a thing that is gone is tolerated", () => {
  const broken = { ...fs(), readdirSync: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } };
  assert.throws(() => findDockerfiles("/r", { root: "/r", fs: broken, join, relative }), /EACCES/);
});

test("fails when the root itself is missing: it is required input, and an empty scan would let the gate pass without auditing any image", () => {
  const fsGone = { ...fs(), readdirSync: () => { throw enoent(); } };
  assert.throws(() => findDockerfiles("/r", { root: "/r", fs: fsGone, join, relative }), /ENOENT/);
});
