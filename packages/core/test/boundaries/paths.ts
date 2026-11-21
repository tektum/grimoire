import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const testDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(testDir, "../../../..");
export const coreSrc = path.join(repoRoot, "packages/core/src");

export function fixture(name: string): string {
  return readFileSync(path.join(testDir, "fixtures", name), "utf8");
}
