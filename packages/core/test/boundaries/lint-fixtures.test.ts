import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { coreSrc, fixture, repoRoot } from "./paths.js";
import { forbiddenModules } from "./scan.js";

const eslint = new ESLint({ cwd: repoRoot });
const insideCore = path.join(coreSrc, "fixture.ts");

async function errorsFor(code: string, filePath = insideCore) {
  const [result] = await eslint.lintText(code, { filePath });
  if (!result) throw new Error("ESLint returned no result");
  return result.messages.filter((m) => m.severity === 2);
}

describe("lint rules for packages/core", () => {
  it.each([
    ["forbidden-pg.ts.txt", "pg"],
    ["forbidden-kysely.ts.txt", "kysely"],
    ["forbidden-pg-boss.ts.txt", "pg-boss"],
    ["forbidden-aws-sdk-client-s3.ts.txt", "@aws-sdk/client-s3"],
    ["forbidden-descope-node-sdk.ts.txt", "@descope/node-sdk"],
    ["forbidden-hocuspocus-server.ts.txt", "@hocuspocus/server"],
    ["forbidden-pino.ts.txt", "pino"],
    ["forbidden-rate-limiter-flexible.ts.txt", "rate-limiter-flexible"],
    ["forbidden-yjs.ts.txt", "yjs"],
    ["forbidden-y-protocols.ts.txt", "y-protocols"],
  ])("reports exactly one error for %s (%s)", async (file) => {
    const errors = await errorsFor(fixture(file));
    expect(errors.map((e) => e.ruleId)).toEqual(["no-restricted-imports"]);
  });

  it("reports an error for process.env", async () => {
    const errors = await errorsFor(fixture("forbidden-env.ts.txt"));
    expect(errors.map((e) => e.ruleId)).toEqual(["no-restricted-syntax"]);
  });

  it.each(["env-named-import.ts.txt", "env-default-import.ts.txt", "env-namespace-alias.ts.txt", "env-destructure.ts.txt"])(
    "reports an error for %s",
    async (file) => {
      expect((await errorsFor(fixture(file))).length).toBeGreaterThan(0);
    },
  );

  it("has no exemption for packages/core/src/config", async () => {
    const errors = await errorsFor(fixture("forbidden-env.ts.txt"), path.join(coreSrc, "config", "fixture.ts"));
    expect(errors).toHaveLength(1);
  });

  it("allows zod in the core", async () => {
    expect(await errorsFor(fixture("allowed-zod.ts.txt"))).toEqual([]);
  });

  it("reports nothing for a clean file", async () => {
    expect(await errorsFor(fixture("clean.ts.txt"))).toEqual([]);
  });

  it.each(forbiddenModules)("does not forbid a look-alike of %s that differs at one character (the module name is matched literally)", async (name) => {
    const lookAlike = `${name.slice(0, -1)}${name.endsWith("x") ? "y" : "x"}`;
    const wildcard = name.replace(/[-/]/, "X"); // a name with the hyphen or slash replaced
    const code = `await import("${lookAlike}");\nawait import("${wildcard}x");\nvoid require("${lookAlike}");\n`;
    expect((await errorsFor(code)).filter((e) => e.ruleId === "no-restricted-syntax")).toEqual([]);
  });

  it.each(forbiddenModules)("forbids static, subpath and dynamic imports of %s", async (name) => {
    const sub = `${name}/sub`;
    const code = `import "${name}";\nimport "${sub}";\nawait import("${sub}");\nvoid require("${name}");\n`;
    const errors = await errorsFor(code);
    expect(errors.filter((e) => e.ruleId?.startsWith("no-restricted-"))).toHaveLength(4);
  });
});
