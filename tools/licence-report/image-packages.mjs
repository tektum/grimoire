#!/usr/bin/env node
// The package audit of a container image (R12.25): which Debian packages a new database image adds to the old one, and under which licences.
// `node tools/licence-report/image-packages.mjs --compare OLD NEW [--out FILE] [--exceptions FILE]` lists the packages of both images (`dpkg-query` inside each, the licence
// names from `/usr/share/doc/<package>/copyright`) and prints the ones only the new image has. Exit 0 only when every added package has permitted licences or an owner exception;
// 1 when one has no copyright file, no licence name, or a licence that is not on the permitted list (copyleft is listed for the owner, never accepted silently); 2 on a usage error.
// `--old-list` and `--new-list` read a list from a file instead of an image (the format `COLLECT` prints), which is how the tests run it without a container runtime.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SHIPPED_LICENCES } from "./allowed-licences.mjs";

/** Run inside an image: one line per package, `name<TAB>version<TAB>License names joined by |` (`-` when the package has no copyright file). */
export const COLLECT = [
  "dpkg-query -W -f='$" + "{Package}\\t$" + "{Version}\\n' | while IFS=\"$(printf '\\t')\" read -r p v; do",
  ' f=/usr/share/doc/$p/copyright;',
  ' if [ -r "$f" ]; then l=$(sed -n \'s/^License:[[:space:]]*//p\' "$f" | sed \'s/[[:space:]].*//\' | sort -u | paste -sd\'|\' -); else l=-; fi;',
  " printf '%s\\t%s\\t%s\\n' \"$p\" \"$v\" \"$l\"; done",
].join('');

export function parseList(text) {
  return text.split("\n").filter((l) => l !== "").map((line) => {
    const parts = line.split("\t");
    if (parts.length !== 3 || parts[0] === "") throw new Error(`malformed package line: ${JSON.stringify(line)}`);
    const [name, version, lic] = parts;
    return { name, version, licences: lic === "-" ? null : lic === "" ? [] : lic.split("|") };
  });
}

export function addedPackages(oldList, newList) {
  const had = new Set(oldList.map((p) => p.name));
  return newList.filter((p) => !had.has(p.name));
}

const ALIASES = new Map([["Expat", "MIT"], ["BSD-3-clause", "BSD-3-Clause"], ["BSD-2-clause", "BSD-2-Clause"], ["Apache-2", "Apache-2.0"], ["ISC", "ISC"], ["Zlib", "Zlib"]]);
export const normaliseLicence = (name) => ALIASES.get(name) ?? name;
const ALLOWED = new Set([...SHIPPED_LICENCES.map((l) => l.id), "Zlib", "Public-Domain"]);

export function evaluate(added, exceptions = []) {
  const valid = exceptions.filter((e) => e && typeof e.package === "string" && e.owner && e.reason);
  return added.map((p) => {
    const row = { name: p.name, version: p.version, licences: p.licences ?? [] };
    const ex = valid.find((e) => e.package === p.name);
    if (ex) return { ...row, status: "exception", detail: `${ex.reason} (owner ${ex.owner})` };
    if (p.licences === null) return { ...row, status: "no-licence-file", detail: `/usr/share/doc/${p.name}/copyright is missing` };
    if (p.licences.length === 0) return { ...row, status: "unparsable", detail: "the copyright file names no licence" };
    const refused = p.licences.map(normaliseLicence).filter((l) => !ALLOWED.has(l));
    return refused.length === 0 ? { ...row, status: "allowed", detail: "" } : { ...row, status: "not-allowed", detail: `not on the permitted list: ${refused.join(", ")}` };
  });
}

export function report({ oldImage, newImage, rows }) {
  const bad = rows.filter((r) => r.status !== "allowed" && r.status !== "exception");
  const lines = [
    "# Packages added by the database image", "",
    `Old image: \`${oldImage}\``, `New image: \`${newImage}\``, "",
    `${String(rows.length)} package(s) in the new image and not in the old one; ${String(bad.length)} for the owner to decide.`, "",
    "| Package | Version | Licences | Result |", "|---|---|---|---|",
    ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.licences.map(normaliseLicence).join(", ") || "-"} | ${r.status}${r.detail ? `: ${r.detail}` : ""} |`),
  ];
  return `${lines.join("\n")}\n`;
}

function collect(image) {
  const r = spawnSync("docker", ["run", "--rm", "--entrypoint", "sh", image, "-c", COLLECT], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`could not list the packages of ${image}: ${r.stderr.trim() || "docker failed"}`);
  return r.stdout;
}

function main(argv) {
  const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  const at = argv.indexOf("--compare");
  const [oldImage, newImage] = at === -1 ? [] : [argv[at + 1], argv[at + 2]];
  if (!oldImage || !newImage) { console.error("usage: image-packages.mjs --compare OLD NEW [--out FILE] [--exceptions FILE]"); return 2; }
  try {
    const oldList = parseList(opt("--old-list") ? readFileSync(opt("--old-list"), "utf8") : collect(oldImage));
    const newList = parseList(opt("--new-list") ? readFileSync(opt("--new-list"), "utf8") : collect(newImage));
    const exceptions = opt("--exceptions") ? JSON.parse(readFileSync(opt("--exceptions"), "utf8")) : [];
    const rows = evaluate(addedPackages(oldList, newList), exceptions);
    const text = report({ oldImage, newImage, rows });
    if (opt("--out")) writeFileSync(opt("--out"), text);
    process.stdout.write(text);
    return rows.every((r) => r.status === "allowed" || r.status === "exception") ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
