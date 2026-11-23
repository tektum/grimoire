// Hand-written on purpose: license-checker-rseidelsohn was tried and rejected. It pulls in CC-BY-3.0 and CC0-1.0
// development packages, which the owner's rule (R12.25, Q19) forbids, and it cannot follow private workspace packages.
// Licence rule, SPDX expression evaluation and dependency classification (R12.25).
// Node built-ins only. Pure functions: file access is injected by run.mjs.

import { SHIPPED_LICENCES, DEV_ONLY_EXTRA } from "./allowed-licences.mjs";

export const SHIPPED_ALLOWED = SHIPPED_LICENCES.map((l) => l.id);
export const DEV_ALLOWED = [...SHIPPED_ALLOWED, ...DEV_ONLY_EXTRA.map((l) => l.id)];

export function allowedFor(cls) {
  return new Set(cls === "shipped" ? SHIPPED_ALLOWED : DEV_ALLOWED);
}

/** Turn the package.json `license` / `licenses` shapes into one SPDX string, or null. */
export function normaliseLicenceField(meta) {
  if (!meta) return null;
  const pick = (v) => (typeof v === "string" ? v : v && typeof v.type === "string" ? v.type : null);
  const single = pick(meta.license);
  if (single) return single;
  if (Array.isArray(meta.licenses)) {
    const all = meta.licenses.map(pick);
    if (all.length > 0 && all.every(Boolean)) return all.length === 1 ? all[0] : `(${all.join(" OR ")})`;
  }
  return null;
}

/**
 * Parse an SPDX expression (OR, AND, WITH, parentheses; AND binds tighter than OR).
 * Returns a tree, or null when the expression cannot be parsed.
 */
export function parseExpression(text) {
  if (typeof text !== "string") return null;
  const tokens = text.match(/\(|\)|[^\s()]+/g);
  if (!tokens) return null;
  let i = 0;
  const kw = (t) => (t ? t.toUpperCase() : "");
  function or() {
    let left = and();
    while (left && kw(tokens[i]) === "OR") {
      i++;
      const right = and();
      if (!right) return null;
      left = { op: "OR", left, right };
    }
    return left;
  }
  function and() {
    let left = atom();
    while (left && kw(tokens[i]) === "AND") {
      i++;
      const right = atom();
      if (!right) return null;
      left = { op: "AND", left, right };
    }
    return left;
  }
  function atom() {
    const t = tokens[i];
    if (t === undefined) return null;
    if (t === "(") {
      i++;
      const inner = or();
      if (!inner || tokens[i] !== ")") return null;
      i++;
      return inner;
    }
    if (t === ")" || ["OR", "AND", "WITH"].includes(kw(t))) return null;
    i++;
    if (kw(tokens[i]) === "WITH") {
      i++;
      const exc = tokens[i];
      if (exc === undefined || exc === "(" || exc === ")") return null;
      i++;
      return { id: t.replace(/\+$/, ""), plus: t.endsWith("+"), withException: exc };
    }
    if (!/^[A-Za-z0-9.+-]+$/.test(t)) return null;
    return { id: t.replace(/\+$/, ""), plus: t.endsWith("+") };
  }
  const tree = or();
  return tree && i === tokens.length ? tree : null;
}

/** True when the tree satisfies the allowed set (OR: one option; AND: all). WITH and `+` never pass. */
export function satisfies(tree, allowed) {
  if (tree.op === "OR") return satisfies(tree.left, allowed) || satisfies(tree.right, allowed);
  if (tree.op === "AND") return satisfies(tree.left, allowed) && satisfies(tree.right, allowed);
  return !tree.withException && !tree.plus && allowed.has(tree.id);
}

/** Judge one licence string for a class: {ok, reason}. */
export function judgeLicence(licence, cls) {
  if (licence === null || licence === undefined || licence === "") return { ok: false, reason: "missing licence field" };
  const tree = parseExpression(licence);
  if (!tree) return { ok: false, reason: `unparseable licence expression "${licence}"` };
  if (satisfies(tree, allowedFor(cls))) return { ok: true };
  return { ok: false, reason: `licence "${licence}" is not allowed for ${cls} packages` };
}

// ---- version ranges for exceptions: "*", an exact version, or space-separated comparators ----
function parseVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\+.*)?$/.exec(String(v).trim());
  // a prerelease (1.0.0-rc.1) does not parse: it is not the release it precedes, so a range never covers it except by naming it exactly
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}
function cmp(a, b) {
  for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  return 0;
}
export function versionInRange(version, range) {
  const r = String(range).trim();
  if (r === "*") return true;
  if (r.replace(/^=/, "") === String(version).trim()) return true;
  const v = parseVersion(version);
  if (!v) return false;
  const parts = r.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  for (const p of parts) {
    const m = /^(>=|<=|>|<|=)?(\d.*)$/.exec(p);
    if (!m) return false;
    const target = parseVersion(m[2]);
    if (!target) return false;
    const c = cmp(v, target);
    const ok = { ">=": c >= 0, "<=": c <= 0, ">": c > 0, "<": c < 0, "=": c === 0, undefined: c === 0 }[m[1]];
    if (!ok) return false;
  }
  return true;
}

function toInterval(range) {
  const r = String(range).trim();
  const iv = { lo: [-Infinity, 0, 0], loInc: true, hi: [Infinity, 0, 0], hiInc: true };
  if (r === "*") return iv;
  for (const p of r.split(/\s+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<|=)?(\d.*)$/.exec(p);
    const v = m && parseVersion(m[2]);
    if (!v) return null;
    const op = m[1] ?? "=";
    if (op === ">=" || op === ">" || op === "=") {
      const c = cmp(v, iv.lo);
      if (c > 0 || (c === 0 && op === ">")) Object.assign(iv, { lo: v, loInc: op !== ">" });
    }
    if (op === "<=" || op === "<" || op === "=") {
      const c = cmp(v, iv.hi);
      if (c < 0 || (c === 0 && op === "<")) Object.assign(iv, { hi: v, hiInc: op !== "<" });
    }
  }
  return iv;
}

/** True when two version ranges share a version. Unparseable ranges count as overlapping (conservative). */
export function versionsOverlap(a, b) {
  const x = toInterval(a);
  const y = toInterval(b);
  if (!x || !y) {
    // A prerelease has no interval here. Two exact version strings, one of them such a prerelease, overlap only when they are the same string; anything else unparseable counts as overlapping.
    const exact = (r) => /^=?\s*\d[^\s<>=*]*$/.test(String(r).trim());
    const [ea, eb] = [a, b].map((r) => String(r).trim().replace(/^=\s*/, ""));
    return exact(a) && exact(b) ? ea === eb : true;
  }
  const lo = cmp(x.lo, y.lo) >= 0 ? x : y;
  const hi = cmp(x.hi, y.hi) <= 0 ? x : y;
  const c = cmp(lo.lo, hi.hi);
  return c < 0 || (c === 0 && lo.loInc && hi.hiInc && bothInclude(x, y, lo.lo));
}
function bothInclude(x, y, v) {
  const inc = (i) => (cmp(i.lo, v) < 0 || (cmp(i.lo, v) === 0 && i.loInc)) && (cmp(i.hi, v) > 0 || (cmp(i.hi, v) === 0 && i.hiInc));
  return inc(x) && inc(y);
}

/** Find an exception for name/version/licence. Exceptions: {name, versions, licence, reason, source, approvedBy}. */
export function findException(exceptions, name, version, licence) {
  return (
    exceptions.find(
      (e) => e.name === name && e.licence === licence && typeof e.versions === "string" && versionInRange(version, e.versions),
    ) ?? null
  );
}

// ---- dependency graph ----
function nameOfKey(key) {
  const i = key.lastIndexOf("node_modules/");
  return i === -1 ? key : key.slice(i + "node_modules/".length);
}

function resolveDep(packages, fromKey, depName) {
  let base = fromKey;
  for (;;) {
    const candidate = base === "" ? `node_modules/${depName}` : `${base}/node_modules/${depName}`;
    if (packages[candidate]) return candidate;
    if (base === "") return null;
    const i = base.lastIndexOf("/node_modules/");
    if (i !== -1) base = base.slice(0, i);
    else if (base.startsWith("node_modules/")) base = "";
    else base = ""; // workspace dir: fall back to the root node_modules
  }
}

/**
 * Classify every non-workspace package in a lockfile (v2/v3 `packages` map).
 * Workspace roots (the "" root and every non-node_modules key) and linked workspace packages are private and excluded.
 * `shipped`: reachable through dependencies/optional/peer edges starting at any workspace's `dependencies`.
 * `dev`: reachable only from workspaces' `devDependencies`. Unreachable packages count as shipped (strict).
 * Returns Map key -> {name, version, class, path: string[]}.
 */
export function classifyGraph(lock) {
  const packages = lock.packages ?? {};
  const isWorkspaceKey = (k) => !k.includes("node_modules/");
  const target = (k) => {
    const e = packages[k];
    return e && e.link && e.resolved && packages[e.resolved] ? e.resolved : k;
  };
  const result = new Map();
  const edges = (k) => {
    const e = packages[k];
    return [e.dependencies, e.optionalDependencies, e.peerDependencies].flatMap((o) => Object.keys(o ?? {}));
  };
  function walk(seeds, cls, skip) {
    const parent = new Map();
    const queue = [];
    for (const { key, via } of seeds) {
      const t = target(key);
      if (!parent.has(t)) {
        parent.set(t, via);
        queue.push(t);
      }
    }
    while (queue.length) {
      const k = queue.shift();
      for (const dep of edges(k)) {
        const r = resolveDep(packages, k, dep);
        if (!r) continue;
        const t = target(r);
        if (!parent.has(t)) {
          parent.set(t, k);
          queue.push(t);
        }
      }
    }
    const pathOf = (k) => {
      const p = [];
      for (let cur = k; cur !== undefined; cur = parent.get(cur)) {
        const wsOnly = isWorkspaceKey(cur);
        p.unshift(wsOnly ? (cur === "" ? "(root)" : cur) : nameOfKey(cur));
        if (wsOnly) break;
      }
      return p;
    };
    for (const k of parent.keys()) {
      if (isWorkspaceKey(k) || packages[k].link || skip.has(k)) continue;
      result.set(k, { name: packages[k].name ?? nameOfKey(k), version: packages[k].version ?? "", class: cls, path: pathOf(k) });
    }
  }
  const workspaces = Object.keys(packages).filter(isWorkspaceKey);
  const seedsFor = (field) =>
    workspaces.flatMap((w) =>
      Object.keys(packages[w][field] ?? {}).flatMap((d) => {
        const r = resolveDep(packages, w, d);
        return r ? [{ key: r, via: w }] : [];
      }),
    );
  walk(seedsFor("dependencies").concat(seedsFor("optionalDependencies")), "shipped", new Set());
  walk(seedsFor("devDependencies"), "dev", new Set(result.keys()));
  for (const k of Object.keys(packages)) {
    if (isWorkspaceKey(k) || packages[k].link || result.has(k)) continue;
    result.set(k, { name: packages[k].name ?? nameOfKey(k), version: packages[k].version ?? "", class: "shipped", path: ["(unreachable from any workspace)", nameOfKey(k)] });
  }
  return result;
}

const EXCEPTION_FIELDS = ["name", "versions", "licence", "reason", "source", "approvedBy", "expires"];
const PENDING_FIELDS = ["name", "version", "licence", "question", "date"];
const isoDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

function validateList(list, fields, label, extra) {
  const errors = [];
  if (!Array.isArray(list)) return [`${label} must be a JSON array`];
  list.forEach((e, i) => {
    const where = `${label}[${i}]${e && typeof e.name === "string" ? ` (${e.name})` : ""}`;
    if (!e || typeof e !== "object" || Array.isArray(e)) return errors.push(`${where}: must be an object`);
    for (const f of fields) if (typeof e[f] !== "string" || e[f].trim() === "") errors.push(`${where}: field "${f}" is missing or empty`);
    for (const f of Object.keys(e)) if (!fields.includes(f)) errors.push(`${where}: unknown field "${f}"`);
    errors.push(...extra(e, where));
  });
  return errors;
}

/** Validate licence-exceptions.json entries. `today` is yyyy-mm-dd. Returns a list of error messages. */
export function validateExceptions(list, today) {
  const errors = validateList(list, EXCEPTION_FIELDS, "licence-exceptions.json", (e, where) => {
    if (typeof e.expires !== "string" || e.expires === "") return [];
    if (!isoDate(e.expires)) return [`${where}: "expires" must be an ISO date yyyy-mm-dd`];
    return e.expires < today ? [`${where}: exception expired on ${e.expires}`] : [];
  });
  if (Array.isArray(list))
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a?.name && a.name === b?.name && a.licence === b?.licence && typeof a.versions === "string" && typeof b.versions === "string" && versionsOverlap(a.versions, b.versions))
          errors.push(`licence-exceptions.json: duplicate exceptions [${i}] and [${j}] for ${a.name} (${a.licence}): versions "${a.versions}" and "${b.versions}" overlap`);
      }
  return errors;
}

/** Validate pending.json entries (open items awaiting an owner decision). */
export function validatePending(list) {
  const errors = validateList(list, PENDING_FIELDS, "pending.json", (e, where) =>
    typeof e.date === "string" && e.date !== "" && !isoDate(e.date) ? [`${where}: "date" must be yyyy-mm-dd`] : [],
  );
  if (Array.isArray(list))
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        if (list[i]?.name && list[i].name === list[j]?.name && list[i].version === list[j]?.version)
          errors.push(`pending.json: duplicate items [${i}] and [${j}] for ${list[i].name}@${list[i].version}`);
  return errors;
}

/** Validate images.json source text: the same image (after normalising docker.io/library) must not be listed twice. */
export function validateImagesText(text) {
  const keys = [];
  let depth = 0;
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"\s*(:)?|[{[]|[}\]]/g)) {
    if (m[0] === "{" || m[0] === "[") depth++;
    else if (m[0] === "}" || m[0] === "]") depth--;
    else if (m[2] && depth === 1) keys.push(JSON.parse(`"${m[1]}"`));
  }
  const seen = new Map();
  const errors = [];
  keys.forEach((k, i) => {
    const norm = parseImageRef(k).repo;
    if (seen.has(norm)) errors.push(`images.json: image "${norm}" is listed twice (entries [${seen.get(norm)}] "${keys[seen.get(norm)]}" and [${i}] "${k}")`);
    else seen.set(norm, i);
  });
  return errors;
}

/**
 * Apply the rule. `readMeta(key)` returns the installed package.json object or null when not installed;
 * a package that is not installed is checked with the licence recorded in the lockfile.
 * Returns {packages, violations, pending, usedExceptions, unusedPending}.
 * `pending` lists failing packages that match a known open item; they are not in `violations`.
 */
export function checkLock(lock, { readMeta, exceptions = [], pending = [] }) {
  for (const [k, v] of Object.entries(lock.packages ?? {})) {
    // bun.lock keeps its packages as tuples under bare names: reading it as an npm-style map would drop every package and pass
    if (Array.isArray(v)) throw new Error(`lock is not the npm-style map (key "${k}" is a tuple): convert bun.lock with bunLockToPackages`);
  }
  // A real lock always has the root entry and at least one package below it: an empty or missing map is a failed conversion, never a pass.
  const keys = Object.keys(lock.packages ?? {});
  if (keys.length === 0) throw new Error("lock has no packages: refusing to pass an empty dependency graph");
  if (!keys.includes("")) throw new Error('lock has no root entry (key ""): refusing to pass a graph that cannot be classified');
  if (!keys.some((k) => k.startsWith("node_modules/"))) throw new Error("lock has no packages below the workspaces: refusing to pass an empty dependency graph");
  const classes = classifyGraph(lock);
  const out = [];
  const violations = [];
  const pendingHits = [];
  const usedEx = new Set();
  const usedPending = new Set();
  for (const [key, c] of [...classes].sort((a, b) => a[0].localeCompare(b[0]))) {
    const entry = lock.packages[key];
    const meta = readMeta(key);
    const installed = Boolean(meta);
    const licence = normaliseLicenceField(meta) ?? normaliseLicenceField(entry);
    const name = meta?.name ?? c.name;
    const version = meta?.version ?? c.version;
    const verdict = judgeLicence(licence, c.class);
    const row = { name, version, licence, class: c.class, installed, allowed: verdict.ok, exception: null, pending: null, path: c.path };
    if (!verdict.ok) {
      const fix = "run `node tools/licence-report/record-licences.mjs` and commit lock-licences.json";
      const reason = !licence && !installed
        ? entry?.recordMismatch
          ? `not installed, and its integrity recorded in lock-licences.json differs from bun.lock: ${fix}`
          : `not installed and not recorded in lock-licences.json: ${fix}`
        : verdict.reason;
      const ex = licence ? findException(exceptions, name, version, licence) : null;
      const pi = pending.findIndex((p) => p.name === name && p.version === version && p.licence === licence);
      if (ex) {
        usedEx.add(ex);
        row.allowed = true;
        row.exception = { reason: ex.reason, approvedBy: ex.approvedBy, expires: ex.expires };
      } else if (pi !== -1) {
        usedPending.add(pi);
        row.allowed = false;
        row.pending = { question: pending[pi].question, date: pending[pi].date };
        pendingHits.push({ ...row, reason });
      } else violations.push({ ...row, reason });
    }
    out.push(row);
  }
  return {
    packages: out,
    violations,
    pending: pendingHits,
    usedExceptions: usedEx,
    unusedPending: pending.filter((_, i) => !usedPending.has(i)),
  };
}

/** Summary rows: licence, class, count. */
export function summarise(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = `${r.licence ?? "(missing)"}\u0000${r.class}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m]
    .map(([k, count]) => {
      const [licence, cls] = k.split("\u0000");
      return { licence, class: cls, count };
    })
    .sort((a, b) => a.class.localeCompare(b.class) || b.count - a.count || a.licence.localeCompare(b.licence));
}

// ---- container images ----
export function parseImageRef(ref) {
  const noDigest = ref.split("@")[0];
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.indexOf(":", slash + 1);
  const repo = colon === -1 ? noDigest : noDigest.slice(0, colon);
  const tag = colon === -1 ? "" : noDigest.slice(colon + 1);
  return { repo: repo.replace(/^docker\.io\/(library\/)?/, ""), tag };
}

export function extractImages(composeText, dockerfiles = []) {
  const refs = [];
  for (const m of composeText.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)) refs.push({ ref: m[1], from: "compose" });
  for (const d of dockerfiles) {
    const stages = new Set();
    for (const m of d.text.matchAll(/^\s*FROM\s+(?:--\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/gim)) {
      if (m[1] !== "scratch" && !stages.has(m[1])) refs.push({ ref: m[1], from: d.name });
      if (m[2]) stages.add(m[2]);
    }
  }
  return refs;
}

/** Check images against the reviewed map and exceptions. Returns {images, violations}. */
export function checkImages(refs, map, exceptions = []) {
  const usedEx = new Set();
  const images = [];
  const violations = [];
  for (const { ref, from } of refs) {
    const { repo, tag } = parseImageRef(ref);
    const known = map[repo];
    if (!known) {
      violations.push({ image: ref, from, reason: `image "${repo}" is not in images.json` });
      continue;
    }
    if (!Array.isArray(known.tags) || !known.tags.includes(tag)) {
      violations.push({ image: ref, from, reason: `tag "${tag}" of image "${repo}" is not pinned in images.json (known: ${(known.tags ?? []).join(", ") || "none"})` });
      continue;
    }
    const row = { image: ref, from, licence: known.licence, source: known.source, allowed: true, exception: null };
    if (!judgeLicence(known.licence, "shipped").ok) {
      const ex = findException(exceptions, repo, /^\d/.test(tag) ? tag : "0", known.licence);
      if (ex) {
        usedEx.add(ex);
        row.exception = { reason: ex.reason, approvedBy: ex.approvedBy, expires: ex.expires };
      } else {
        row.allowed = false;
        violations.push({ ...row, reason: `licence "${known.licence}" of image "${repo}" is not allowed and has no matching exception` });
      }
    }
    images.push(row);
  }
  return { images, violations, usedExceptions: usedEx };
}
