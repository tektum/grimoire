import { test } from "node:test";
import assert from "node:assert/strict";
import { bunLockToPackages, keyElements, parseJsonc } from "../bun-lock.mjs";
import { checkLock } from "../licence.mjs";

const text = `{
  // bun writes trailing commas
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "root", "devDependencies": { "dev-tool": "1.0.0", }, },
    "apps/server": { "name": "server", "dependencies": { "@s/lib": "1.0.0", "other": "*" }, },
  },
  "packages": {
    "server": ["server@workspace:apps/server"],
    "@s/lib": ["@s/lib@1.0.0", "", { "dependencies": { "inner": "^2" } }, "sha512-a"],
    "inner": ["inner@2.0.0", "", {}, "sha512-b"],
    "dev-tool": ["dev-tool@1.0.0", "", { "dependencies": { "inner": "^1" } }, "sha512-c"],
    "dev-tool/inner": ["inner@1.5.0", "", {}, "sha512-d"],
    "@s/lib/@t/deep": ["@t/deep@3.0.0", "", {}, "sha512-e"],
  },
}`;

test("keys are split into path elements, a scope and its name staying together", () => {
  assert.deepEqual(keyElements("@s/lib/@t/deep"), ["@s/lib", "@t/deep"]);
  assert.deepEqual(keyElements("a/b"), ["a", "b"]);
  assert.deepEqual(parseJsonc('{"a": "x // not a comment", /* c */ "b": [1,],}'), { a: "x // not a comment", b: [1] });
});

test("the lockfile becomes the npm-style map: nested copies under their parent, workspaces as links", () => {
  const { packages } = bunLockToPackages(text, { "inner@1.5.0": { licence: "ISC", integrity: "sha512-d" } });
  assert.deepEqual(packages["node_modules/server"], { resolved: "apps/server", link: true });
  assert.equal(packages["node_modules/dev-tool/node_modules/inner"].version, "1.5.0");
  assert.equal(packages["node_modules/dev-tool/node_modules/inner"].license, "ISC");
  assert.equal(packages["node_modules/@s/lib/node_modules/@t/deep"].name, "@t/deep");
  assert.deepEqual(Object.keys(packages["apps/server"].dependencies), ["@s/lib", "other"]);
});

test("production and development are told apart, and a nested copy resolves before the hoisted one", () => {
  const lock = bunLockToPackages(text, { "inner@1.5.0": { licence: "ISC", integrity: "sha512-d" }, "inner@2.0.0": { licence: "MIT", integrity: "sha512-b" }, "@t/deep@3.0.0": { licence: "MIT", integrity: "sha512-e" }, "dev-tool@1.0.0": { licence: "MIT", integrity: "sha512-c" }, "@s/lib@1.0.0": { licence: "MIT", integrity: "sha512-a" } });
  const r = checkLock(lock, { readMeta: () => null });
  const by = Object.fromEntries(r.packages.map((p) => [`${p.name}@${p.version}`, p.class]));
  assert.equal(by["@s/lib@1.0.0"], "shipped");
  assert.equal(by["inner@2.0.0"], "shipped");
  assert.equal(by["dev-tool@1.0.0"], "dev");
  assert.equal(by["inner@1.5.0"], "dev");
});

test("a text that is not a bun.lock is refused", () => {
  assert.throws(() => bunLockToPackages("{}"), /not a bun.lock/);
});

test("a recorded licence is used only when its integrity is the one in bun.lock", () => {
  const same = bunLockToPackages(text, { "inner@1.5.0": { licence: "ISC", integrity: "sha512-d" } });
  assert.equal(same.packages["node_modules/dev-tool/node_modules/inner"].license, "ISC");
  const other = bunLockToPackages(text, { "inner@1.5.0": { licence: "ISC", integrity: "sha512-OTHER" } });
  assert.equal(other.packages["node_modules/dev-tool/node_modules/inner"].license, undefined);
  assert.equal(other.packages["node_modules/dev-tool/node_modules/inner"].recordMismatch, true);
  const none = bunLockToPackages(text, {});
  assert.equal(none.packages["node_modules/dev-tool/node_modules/inner"].recordMismatch, false);
});

test("an unrecorded or mismatching package that is not installed fails, with a message that says how to fix it", () => {
  const lock = bunLockToPackages(text, { "inner@1.5.0": { licence: "ISC", integrity: "sha512-OTHER" } });
  const r = checkLock(lock, { readMeta: () => null });
  const reasons = r.violations.map((v) => v.reason);
  assert.ok(reasons.some((x) => /integrity .* differs from bun\.lock.*record-licences/.test(x)), reasons.join("|"));
  assert.ok(reasons.some((x) => /not recorded in lock-licences\.json.*record-licences/.test(x)), reasons.join("|"));
});

test("fail-closed: a record for another version, and a forbidden recorded licence, both fail", () => {
  const bumped = bunLockToPackages(text, { "inner@1.4.0": { licence: "ISC", integrity: "sha512-d" } });
  const a = checkLock(bumped, { readMeta: () => null });
  assert.ok(a.violations.some((v) => v.name === "inner" && v.version === "1.5.0"));
  const forbidden = bunLockToPackages(text, { "inner@1.5.0": { licence: "GPL-3.0-only", integrity: "sha512-d" } });
  const b = checkLock(forbidden, { readMeta: () => null });
  assert.ok(b.violations.some((v) => v.name === "inner" && v.version === "1.5.0"));
});
