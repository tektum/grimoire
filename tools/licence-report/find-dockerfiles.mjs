import * as nodeFs from "node:fs";
import { join as nodeJoin, relative as nodeRelative } from "node:path";

const SKIPPED = ["node_modules", ".git", "reference", "out"];
const gone = (e) => e !== null && typeof e === "object" && e.code === "ENOENT";

/**
 * Every Dockerfile under `dir`, with its text, named relative to `root`. The tree can change while it is walked (the tests of this folder make and remove scratch directories inside it, in other
 * processes of the same run): a directory or a file that is gone by the time it is read is not there, and any other error is the scan's own.
 */
export function findDockerfiles(dir, { root = dir, fs = nodeFs, join = nodeJoin, relative = nodeRelative, found = [] } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (gone(e)) return found;
    throw e;
  }
  for (const d of entries) {
    if (SKIPPED.includes(d.name)) continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) findDockerfiles(p, { root, fs, join, relative, found });
    else if (/^Dockerfile(\..+)?$/.test(d.name)) {
      try {
        found.push({ name: relative(root, p), text: fs.readFileSync(p, "utf8") });
      } catch (e) {
        if (!gone(e)) throw e;
      }
    }
  }
  return found;
}
