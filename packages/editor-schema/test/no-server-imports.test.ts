import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = path.join(import.meta.dirname, "../src");
const forbidden = /^(yjs|y-prosemirror|piscina|hono|kysely|pg)(\/|$)|^@tektum\/grimoire-adapter-/;

describe("editor-schema stays shared with the browser", () => {
  it("imports no server library, Yjs or adapter in src", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(src, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".ts")) continue;
      const text = readFileSync(path.join(src, file), "utf8");
      for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        if (forbidden.test(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
