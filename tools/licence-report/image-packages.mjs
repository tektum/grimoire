#!/usr/bin/env node
// The package audit of a container image (R12.25): which Debian packages a new database image adds to the old one, and under which licences.
// `node tools/licence-report/image-packages.mjs --compare OLD NEW [--out FILE] [--exceptions FILE]` lists the packages of both images (`dpkg-query` inside each, the licence
// names from `/usr/share/doc/<package>/copyright`) and prints the ones only the new image has. Exit 0 only when every added package has permitted licences or an owner exception;
// 1 when one has no copyright file, no licence name, or a licence that is not on the permitted list (copyleft is listed for the owner, never accepted silently); 2 on a usage error.
// `--old-list` and `--new-list` read a list from a file instead of an image (the format `COLLECT` prints), which is how the tests run it without a container runtime.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SHIPPED_LICENCES } from "./allowed-licences.mjs";

/**
 * Run inside an image: one line per package, `name<TAB>version<TAB>License lines of its copyright file joined by |` (`-` when it has none). The copyright file is looked for
 * under the package, then under its source package (Debian ships it there for split packages), then wherever `dpkg -L` says one is. `dpkg-query` runs on its own, before the
 * pipeline, so that its failure ends the script: a pipeline would hide it behind the status of the last command and an empty list would pass for an image with nothing in it.
 */
export const COLLECT = [
  "out=$(dpkg-query -W -f='$" + "{Package}\\t$" + "{Version}\\t$" + "{source:Package}\\n') || exit 1;",
  ' printf \'%s\\n\' "$out" | while IFS="$(printf \'\\t\')" read -r p v src; do',
  ' f=;',
  ' for c in "/usr/share/doc/$p/copyright" "/usr/share/doc/$src/copyright" "$(dpkg -L "$p" 2>/dev/null | grep \'/copyright$\' | head -n 1)"; do',
  ' if [ -n "$c" ] && [ -r "$c" ]; then f=$c; break; fi; done;',
  ' if [ -n "$f" ]; then l=$(sed -n \'s/^License:[[:space:]]*//p\' "$f" | sed \'s/[[:space:]]*$//\' | sort -u | paste -sd\'|\' -);',
  ' if [ -z "$l" ]; then l=$(grep -oE \'GNU (Lesser |Library |Affero )?General Public License|Apache License,? Version [0-9]+(\.[0-9]+)*|Python Software Foundation\' "$f" | sort -u | sed \'s/^/text:/\' | paste -sd\'|\' -); fi;',
  ' else l=-; fi;',
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

const ALIASES = new Map([["public-domain", "Public-Domain"], ["Expat", "MIT"], ["BSD-3-clause", "BSD-3-Clause"], ["BSD-2-clause", "BSD-2-Clause"], ["Apache-2", "Apache-2.0"], ["ISC", "ISC"], ["Zlib", "Zlib"]]);
export const normaliseLicence = (name) => ALIASES.get(name) ?? name;
const ALLOWED = new Set([...SHIPPED_LICENCES.map((l) => l.id), "Zlib", "Public-Domain"]);

/** The names in one `License:` value that stop it being permitted: `a and b` needs both, `a or b` needs one of them, and nothing is judged by its first word. */
function refusedIn(expression) {
  if (expression.startsWith("text:")) return /^text:Apache License,? Version 2\.0$/.test(expression) ? [] : [`free text: ${expression.slice(5)}`];
  return expression.split(/\s+and\s+/).flatMap((group) => {
    const alternatives = group.split(/\s+or\s+/).map((name) => normaliseLicence(name.trim())).filter((name) => name !== "");
    return alternatives.some((name) => ALLOWED.has(name)) ? [] : alternatives;
  });
}

export function evaluate(added, exceptions = []) {
  const valid = exceptions.filter((e) => e && typeof e.package === "string" && e.owner && e.reason);
  return added.map((p) => {
    const row = { name: p.name, version: p.version, licences: p.licences ?? [] };
    const ex = valid.find((e) => e.package === p.name);
    if (ex) return { ...row, status: "exception", detail: `${ex.reason} (owner ${ex.owner})` };
    if (p.licences === null) return { ...row, status: "no-licence-file", detail: `/usr/share/doc/${p.name}/copyright is missing` };
    if (p.licences.length === 0) return { ...row, status: "unparsable", detail: "the copyright file names no licence" };
    const refused = p.licences.flatMap(refusedIn);
    return refused.length === 0 ? { ...row, status: "allowed", detail: "" } : { ...row, status: "not-allowed", detail: `not on the permitted list: ${refused.join(", ")}` };
  });
}

export function report({ oldImage, newImage, rows, common }) {
  const bad = rows.filter((r) => r.status !== "allowed" && r.status !== "exception");
  const lines = [
    "# Packages added by the database image", "",
    `Old image: \`${oldImage}\``, `New image: \`${newImage}\``, "",
    ...(common === undefined ? [] : [`${String(common)} package(s) are in both images (the image base) and are not listed.`, ""]),
    `${String(rows.length)} package(s) in the new image and not in the old one; ${String(bad.length)} not permitted and without an exception.`, "",
    "| Package | Version | Licences | Result |", "|---|---|---|---|",
    ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.licences.map(normaliseLicence).join(", ") || "-"} | ${r.status}${r.detail ? `: ${r.detail}` : ""} |`),
  ];
  return `${lines.join("\n")}\n`;
}

/** The image of a service in the JSON that `docker compose config --format json` prints. Each way it can go wrong is its own message: empty output must not become a parse error. */
export function imageFromCompose(text, service) {
  if (text.trim() === "") throw new Error("`docker compose config` printed nothing");
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("`docker compose config` printed something that is not JSON"); }
  const entry = parsed?.services?.[service];
  if (entry === undefined) throw new Error(`the Compose files have no service "${service}"`);
  if (typeof entry.image !== "string" || entry.image === "") throw new Error(`service "${service}" has no image`);
  return entry.image;
}

/** The image a set of Compose files gives a service. The example environment is loaded: the files require variables that only a real `.env` has, and only the image is read. */
function composeImage(files, service) {
  const args = ["compose", "--env-file", ".env.example", ...files.flatMap((f) => ["-f", f]), "config", "--format", "json"];
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw new Error(`could not run \`docker compose\`: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`\`docker compose config\` failed (${files.join(", ")}): ${r.stderr.trim()}`);
  return imageFromCompose(r.stdout, service);
}

function collect(image) {
  const r = spawnSync("docker", ["run", "--rm", "--entrypoint", "sh", image, "-c", COLLECT], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`could not list the packages of ${image}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`could not list the packages of ${image}: ${r.stderr.trim() || "docker failed"}`);
  return r.stdout;
}

function main(argv) {
  const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  const at = argv.indexOf("--compare");
  const fromCompose = opt("--new-from-compose");
  const [oldImage, positionalNew] = at === -1 ? [] : [argv[at + 1], argv[at + 2]];
  if (!oldImage || (!positionalNew && !fromCompose) || (fromCompose && positionalNew?.startsWith("--") === false)) { console.error("usage: image-packages.mjs --compare OLD (NEW | --new-from-compose FILE[,FILE]) [--service NAME] [--out FILE] [--exceptions FILE]"); return 2; }
  try {
    const newImage = fromCompose ? composeImage(fromCompose.split(","), opt("--service") ?? "postgres") : positionalNew;
    const oldList = parseList(opt("--old-list") ? readFileSync(opt("--old-list"), "utf8") : collect(oldImage));
    const newList = parseList(opt("--new-list") ? readFileSync(opt("--new-list"), "utf8") : collect(newImage));
    const exceptionsPath = opt("--exceptions") ?? fileURLToPath(new URL("image-exceptions.json", import.meta.url));
    const exceptions = existsSync(exceptionsPath) ? JSON.parse(readFileSync(exceptionsPath, "utf8")) : [];
    if (oldList.length === 0 || newList.length === 0) throw new Error(`an image listed no packages (${String(oldList.length)} in the old, ${String(newList.length)} in the new): nothing was checked`);
    const added = addedPackages(oldList, newList);
    const rows = evaluate(added, exceptions);
    const text = report({ oldImage, newImage, rows, common: newList.length - added.length });
    if (opt("--out")) writeFileSync(opt("--out"), text);
    process.stdout.write(text);
    const failing = rows.filter((r) => r.status !== "allowed" && r.status !== "exception");
    if (failing.length > 0) console.error(`${String(failing.length)} package(s) fail the audit: ${failing.map((r) => `${r.name} (${r.status})`).join(", ")}`);
    return failing.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
