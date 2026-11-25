import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateModels } from "../licence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runMjs = join(here, "..", "run.mjs");
const repo = join(here, "..", "..", "..");
const lock = JSON.parse(readFileSync(join(repo, "models", "models.lock.json"), "utf8"));
const sha = (model) => lock.files.find((f) => f.model === model && f.name === "model_quantized.onnx").sha256;

const entry = (over = {}) => ({
  name: "multilingual-e5-base",
  licence: "MIT",
  source: "https://huggingface.co/Xenova/multilingual-e5-base",
  sha256: sha("multilingual-e5-base"),
  baseModel: "intfloat/multilingual-e5-base",
  notice: "model-notices/multilingual-e5.MIT.txt",
  notes: "n",
  ...over,
});
const small = () => entry({ name: "multilingual-e5-small", sha256: sha("multilingual-e5-small"), baseModel: "intfloat/multilingual-e5-small", source: "https://huggingface.co/Xenova/multilingual-e5-small" });

test("a model entry without a licence, a sha256 or a source is refused, naming the model and the field", () => {
  for (const key of ["licence", "sha256", "source"]) {
    const without = entry();
    delete without[key];
    const errors = validateModels([without, small()], lock);
    assert.equal(errors.length, 1, key);
    assert.match(errors[0], /multilingual-e5-base/);
    assert.match(errors[0], new RegExp(key));
  }
  assert.deepEqual(validateModels([entry(), small()], lock), []);
});

test("a licence the rule does not allow, a sha256 that is not the lock's, and a model the lock does not have are refused", () => {
  assert.match(validateModels([entry({ licence: "AGPL-3.0" }), small()], lock).join("\n"), /licence/);
  assert.match(validateModels([entry({ sha256: "0".repeat(64) }), small()], lock).join("\n"), /lock/);
  assert.match(validateModels([entry(), small(), entry({ name: "multilingual-e5-large" })], lock).join("\n"), /multilingual-e5-large/);
});

test("every model of the lock has an entry: one that is missing is named", () => {
  const errors = validateModels([entry()], lock);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /multilingual-e5-small/);
});

test("the report lists both models as MIT and exits 0, for the real models list and the real lock", () => {
  // In a root of its own with the real lock: the report scans its root for Dockerfiles, and the repository's own tree is changed by other tests while they run.
  const dir = mkdtempSync(join(tmpdir(), "licence-real-models-"));
  try {
    mkdirSync(join(dir, "models"), { recursive: true });
    writeFileSync(join(dir, "models", "models.lock.json"), JSON.stringify(lock));
    writeFileSync(join(dir, "compose.yaml"), "services: {}\n");
    const r = spawnSync(process.execPath, [runMjs, "--root", dir, "--out", join(dir, "out"), "--check-images"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Models/);
    assert.match(r.stdout, /multilingual-e5-base\s+MIT/);
    assert.match(r.stdout, /multilingual-e5-small\s+MIT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the notice file the entries name exists and is the MIT text", () => {
  const models = JSON.parse(readFileSync(join(repo, "tools", "licence-report", "models.json"), "utf8"));
  for (const m of models) {
    const text = readFileSync(join(repo, "tools", "licence-report", m.notice), "utf8");
    assert.match(text, /Permission is hereby granted, free of charge/);
    assert.match(text, /intfloat\/multilingual-e5-base/);
  }
});

test("the report fails (exit 2) for a models file with an entry that has no licence", () => {
  const dir = mkdtempSync(join(tmpdir(), "licence-models-"));
  try {
    mkdirSync(join(dir, "models"), { recursive: true });
    writeFileSync(join(dir, "models", "models.lock.json"), JSON.stringify(lock));
    writeFileSync(join(dir, "compose.yaml"), "services: {}\n");
    writeFileSync(join(dir, "models.json"), JSON.stringify([{ name: "multilingual-e5-base", source: "x", sha256: sha("multilingual-e5-base") }]));
    const r = spawnSync(process.execPath, [runMjs, "--root", dir, "--out", join(dir, "out"), "--models", join(dir, "models.json"), "--check-images"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /licence/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
