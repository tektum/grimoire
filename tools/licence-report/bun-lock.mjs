// Reads bun's text lockfile (bun.lock, JSONC: comments and trailing commas allowed) and returns the npm-style
// `{ packages }` map that licence.mjs works on: workspace directories as keys with their dependency fields, installed
// packages under `node_modules/...` keys (a nested copy under its parent, as in node_modules), workspace packages as links.
//
// bun.lock records no licence. A package that is installed is read from its own package.json; one that is not (an
// optional package for another platform) takes the licence from `lockLicences` ({ "name@version": { licence, integrity } },
// the file lock-licences.json next to this one, written by record-licences.mjs). A record counts only when its integrity is
// the one bun.lock locks for that package, so a record cannot vouch for a different tarball of the same version.

/** Remove comments and trailing commas outside strings. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** "a/b/@s/c" -> ["a", "b", "@s/c"]: a scope and its name are one path element. */
export function keyElements(key) {
  const parts = key.split("/");
  const out = [];
  for (let i = 0; i < parts.length; i++) out.push(parts[i].startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i]);
  return out;
}

const splitIdent = (ident) => {
  const at = ident.lastIndexOf("@");
  return { name: ident.slice(0, at), spec: ident.slice(at + 1) };
};

export function bunLockToPackages(text, lockLicences = {}) {
  const lock = parseJsonc(text);
  if (!lock || typeof lock !== "object" || !lock.workspaces || !lock.packages) throw new Error("not a bun.lock (no workspaces or packages)");
  const packages = {};
  for (const [dir, ws] of Object.entries(lock.workspaces)) {
    packages[dir] = {
      name: ws.name,
      dependencies: ws.dependencies,
      devDependencies: ws.devDependencies,
      optionalDependencies: ws.optionalDependencies,
      peerDependencies: ws.peerDependencies,
    };
  }
  for (const [key, tuple] of Object.entries(lock.packages)) {
    const elements = keyElements(key);
    const npmKey = `node_modules/${elements.join("/node_modules/")}`;
    const { name, spec } = splitIdent(tuple[0]);
    if (spec.startsWith("workspace:")) {
      packages[npmKey] = { resolved: spec.slice("workspace:".length), link: true };
      continue;
    }
    const meta = tuple[2] ?? {};
    const record = lockLicences[`${name}@${spec}`];
    const recorded = record !== undefined && record.integrity === tuple[3] ? record.licence : undefined;
    packages[npmKey] = {
      name,
      version: spec,
      license: recorded,
      recordMismatch: record !== undefined && recorded === undefined,
      dependencies: meta.dependencies,
      optionalDependencies: meta.optionalDependencies,
      peerDependencies: meta.peerDependencies,
    };
  }
  return { lockfileVersion: lock.lockfileVersion, packages };
}
