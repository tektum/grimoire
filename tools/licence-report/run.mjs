#!/usr/bin/env node
// Licence report (R12.25, R12.36). Usage:
//   node tools/licence-report/run.mjs [--root DIR] [--out DIR] [--exceptions FILE] [--images FILE]
//                                     [--compose FILE] [--check-images]
// Exit 0 when every package and image passes the rule, 1 on any violation, 2 on a usage or input error.
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { bunLockToPackages } from "./bun-lock.mjs";
import { validateExceptions, validatePending, validateImagesText, checkLock, checkImages, extractImages, summarise, SHIPPED_ALLOWED, DEV_ALLOWED } from "./licence.mjs";

const toolDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const root = resolve(opt("--root") ?? process.cwd());
const outDir = resolve(opt("--out") ?? join(toolDir, "out"));
const exceptionsFile = resolve(opt("--exceptions") ?? join(root, "licence-exceptions.json"));
const imagesFile = resolve(opt("--images") ?? join(toolDir, "images.json"));
const composeFile = resolve(opt("--compose") ?? join(root, "compose.yaml"));
const pendingFile = resolve(opt("--pending") ?? join(toolDir, "pending.json"));
const today = opt("--today") ?? new Date().toISOString().slice(0, 10);
const allowPending = args.includes("--allow-pending");
const imagesOnly = args.includes("--check-images");

function fail(message) {
  console.error(`licence: ${message}`);
  process.exit(2);
}
function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return fail(`cannot read ${what} ${file}: ${e.message}`);
  }
}

function findDockerfiles(dir, found = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "reference", "out"].includes(d.name)) continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) findDockerfiles(p, found);
    else if (/^Dockerfile(\..+)?$/.test(d.name)) found.push({ name: relative(root, p), text: readFileSync(p, "utf8") });
  }
  return found;
}

const exceptions = existsSync(exceptionsFile) ? readJson(exceptionsFile, "exceptions file") : [];
const pending = existsSync(pendingFile) ? readJson(pendingFile, "pending file") : [];
const imageErrors = validateImagesText(readFileSync(imagesFile, "utf8"));
const inputErrors = [...validateExceptions(exceptions, today), ...validatePending(pending), ...imageErrors];
if (inputErrors.length) {
  console.error("licence: invalid input files:");
  for (const e of inputErrors) console.error(`  ${e}`);
  process.exit(2);
}

// Images
const imageMap = readJson(imagesFile, "images map");
// Dockerfiles are always checked, with or without a compose file
const refs = extractImages(existsSync(composeFile) ? readFileSync(composeFile, "utf8") : "", findDockerfiles(root));
const imageResult = checkImages(refs, imageMap, exceptions);

let packageResult = { packages: [], violations: [], pending: [], usedExceptions: new Set(), unusedPending: [] };
if (!imagesOnly) {
  const lockFile = join(root, "bun.lock");
  if (!existsSync(lockFile)) fail(`no bun.lock in ${root}`);
  const licencesFile = join(toolDir, "lock-licences.json");
  let lock;
  try {
    lock = bunLockToPackages(readFileSync(lockFile, "utf8"), existsSync(licencesFile) ? readJson(licencesFile, "lock licences") : {});
  } catch (e) {
    fail(`cannot read bun.lock: ${e.message}`);
  }
  const readMeta = (key) => {
    const f = join(root, key, "package.json");
    return existsSync(f) ? readJson(f, "package metadata") : null;
  };
  packageResult = checkLock(lock, { readMeta, exceptions, pending });
}

const summary = summarise(packageResult.packages);
const usedEx = new Set([...packageResult.usedExceptions, ...imageResult.usedExceptions]);
const unusedExceptions = imagesOnly ? [] : exceptions.filter((e) => !usedEx.has(e));
const violations = packageResult.violations.length + imageResult.violations.length;
const pendingHits = packageResult.pending;
const strictFailure = violations > 0 || (pendingHits.length > 0 && !allowPending);
const report = {
  rule: { shipped: SHIPPED_ALLOWED, developmentOnly: DEV_ALLOWED },
  summary,
  packages: packageResult.packages,
  images: imageResult.images,
  violations: { packages: packageResult.violations, images: imageResult.violations },
  pending: pendingHits,
  unusedExceptions,
  unusedPending: packageResult.unusedPending,
  allowPending,
  ok: !strictFailure,
};

if (!imagesOnly) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "licence-report.json"), JSON.stringify(report, null, 2) + "\n");
}

const pad = (s, n) => String(s).padEnd(n);
if (!imagesOnly) {
  const notInstalled = packageResult.packages.filter((p) => !p.installed).length;
  console.log(`Licence summary (${packageResult.packages.length} packages, ${notInstalled} not installed here and checked from the lockfile)`);
  console.log(`${pad("licence", 16)}${pad("class", 14)}count`);
  for (const r of summary) console.log(`${pad(r.licence, 16)}${pad(r.class === "dev" ? "development" : r.class, 14)}${r.count}`);
  for (const p of packageResult.packages.filter((p) => p.exception))
    console.log(`exception applied: ${p.name}@${p.version} (${p.licence}) until ${p.exception.expires} - ${p.exception.reason}`);
}
console.log("Container images");
for (const i of imageResult.images)
  console.log(`  ${i.image.split("@")[0]}  ${i.licence}${i.exception ? " (exception)" : ""}  [${i.from}]`);
for (const e of unusedExceptions) console.warn(`warning: exception ${e.name} ${e.versions} (${e.licence}) is not used by any package or image`);
for (const p of packageResult.unusedPending) console.warn(`warning: pending item ${p.name}@${p.version} (${p.question}) no longer matches any package; remove it`);
if (pendingHits.length) {
  console.warn("\n!!! LICENCE ITEMS AWAITING AN OWNER DECISION !!!");
  for (const p of pendingHits)
    console.warn(`  ${p.name}@${p.version}: ${p.licence} [${p.class}] - open question ${p.pending.question} (${p.pending.date})\n    path: ${p.path.join(" > ")}`);
  console.warn(allowPending ? "  Allowed for this run by --allow-pending. This is NOT a licence approval." : "  Not allowed: run with --allow-pending only to see the rest of the report.");
}
if (violations) {
  console.error(`\nFAILED: ${violations} licence violation(s)`);
  for (const v of packageResult.violations)
    console.error(`  ${v.name}@${v.version}: ${v.reason} [${v.class}]\n    path: ${v.path.join(" > ")}`);
  for (const v of imageResult.violations) console.error(`  image ${v.image} (${v.from}): ${v.reason}`);
  process.exit(1);
}
if (strictFailure) {
  console.error(`\nFAILED: ${pendingHits.length} item(s) awaiting an owner decision: ${pendingHits.map((p) => `${p.name}@${p.version} (${p.pending.question})`).join(", ")}`);
  process.exit(1);
}
console.log(pendingHits.length ? "\nOK with pending items (--allow-pending)" : "\nOK: no licence violations");
