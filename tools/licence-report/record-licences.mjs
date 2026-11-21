#!/usr/bin/env node
// Writes lock-licences.json: the licence and the bun.lock integrity of every locked package that is NOT installed on this machine
// (optional packages of other platforms), which bun.lock does not record. Installed packages are read from node_modules by run.mjs.
// Weakness: the licence is the registry's metadata for name@version, not read from the tarball; the integrity ties the record to the locked tarball only.
// Usage: node tools/licence-report/record-licences.mjs [--root DIR]   (needs the registry for packages not yet recorded)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bunLockToPackages, parseJsonc } from "./bun-lock.mjs";
import { normaliseLicenceField } from "./licence.mjs";

const toolDir = dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf("--root");
const root = resolve(i === -1 ? process.cwd() : process.argv[i + 1]);
const file = join(toolDir, "lock-licences.json");
const known = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const lockText = readFileSync(join(root, "bun.lock"), "utf8");
const { packages } = bunLockToPackages(lockText);
// integrity per name@version, from the lockfile's own tuples (the fourth element)
const integrity = {};
for (const [, tuple] of Object.entries(parseJsonc(lockText).packages)) {
  if (typeof tuple[3] === "string") integrity[tuple[0]] = tuple[3];
}
const out = {};
for (const [key, e] of Object.entries(packages)) {
  if (!key.startsWith("node_modules/") || e.link) continue;
  const id = `${e.name}@${e.version}`;
  if (existsSync(join(root, key, "package.json"))) continue;
  const lockIntegrity = integrity[id];
  if (lockIntegrity === undefined) throw new Error(`bun.lock records no integrity for ${id}`);
  if (known[id]?.integrity === lockIntegrity) {
    out[id] = known[id];
    continue;
  }
  const res = await fetch(`https://registry.npmjs.org/${e.name}/${e.version}`);
  if (!res.ok) throw new Error(`registry answered ${res.status} for ${id}`);
  const licence = normaliseLicenceField(await res.json());
  if (!licence) throw new Error(`the registry records no licence for ${id}`);
  out[id] = { licence, integrity: lockIntegrity };
}
const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`${Object.keys(sorted).length} licences of packages not installed here written to ${file}`);
