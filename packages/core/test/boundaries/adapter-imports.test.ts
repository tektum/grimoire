import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { fixture, repoRoot } from "./paths.js";

const eslint = new ESLint({ cwd: repoRoot });
const at = (rel: string) => path.join(repoRoot, rel);

async function errorsFor(code: string, file: string) {
  const [result] = await eslint.lintText(code, { filePath: at(file) });
  if (!result) throw new Error("ESLint returned no result");
  // Only the boundary rules are under test; bare `import "x"` snippets would also trip unused-variable rules.
  return result.messages.filter((m) => m.severity === 2 && m.ruleId?.startsWith("no-restricted-"));
}
const ruleIds = async (code: string, file: string) => (await errorsFor(code, file)).map((e) => e.ruleId);
const oneError = (rule = "no-restricted-imports") => [rule];

// The adapter list of eslint.config.js itself, so that a new adapter is covered without editing this file.
const adapters = JSON.parse(/const adapterNames = (\[[^\]]*\]);/.exec(readFileSync(path.join(repoRoot, "eslint.config.js"), "utf8"))?.[1] ?? "[]") as string[];
const serverOnly = ["hono", "@hono/node-server", "@hocuspocus/server", "kysely", "pg", "pino", "pg-boss", "crossws", "rate-limiter-flexible", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"];

describe("adapter packages", () => {
  it("covers every adapter that eslint.config.js restricts", () => {
    expect(adapters).toContain("auth-descope");
    expect(adapters).toContain("markdown-milkdown");
    expect(adapters.length).toBeGreaterThanOrEqual(8);
  });

  it("reject importing another adapter (fixture)", async () => {
    expect(await ruleIds(fixture("adapter-imports-adapter.ts.txt"), "packages/adapters/db-kysely/src/fixture.ts")).toEqual(oneError());
  });

  it("reject importing anything under apps/ (fixture)", async () => {
    expect(await ruleIds(fixture("adapter-imports-apps.ts.txt"), "packages/adapters/db-kysely/src/fixture.ts")).toEqual(oneError());
  });

  it.each(adapters)("%s may not import any other adapter, but may import itself and core", async (name) => {
    const file = `packages/adapters/${name}/src/fixture.ts`;
    for (const other of adapters.filter((a) => a !== name)) {
      expect(await ruleIds(`import "@tektum/grimoire-adapter-${other}";`, file)).toEqual(oneError());
      expect(await ruleIds(`await import("@tektum/grimoire-adapter-${other}/sub");`, file)).toEqual(oneError("no-restricted-syntax"));
    }
    expect(await errorsFor(`import "@tektum/grimoire-adapter-${name}";\nimport "@tektum/grimoire-core/ports/logger";`, file)).toEqual([]);
  });

  it.each(["@tektum/grimoire-server", "@tektum/grimoire-web", "@tektum/grimoire-server/sub"])("reject %s", async (name) => {
    const file = "packages/adapters/auth-dev/test/fixture.ts";
    expect(await ruleIds(`import "${name}";`, file)).toEqual(oneError());
    expect(await ruleIds(`void require("${name}");`, file)).toEqual(oneError("no-restricted-syntax"));
  });

  it("may import their own libraries", async () => {
    expect(await errorsFor(`import { Kysely } from "kysely";\nimport pg from "pg";`, "packages/adapters/db-kysely/src/fixture.ts")).toEqual([]);
  });
});

describe("apps/web", () => {
  it.each(serverOnly)("rejects %s (static, subpath and dynamic)", async (name) => {
    const file = "apps/web/src/fixture.ts";
    expect(await ruleIds(`import "${name}";`, file)).toEqual(oneError());
    expect(await ruleIds(`import "${name}/sub";`, file)).toEqual(oneError());
    expect(await ruleIds(`await import("${name}");`, file)).toEqual(oneError("no-restricted-syntax"));
  });

  it("rejects an adapter (fixture)", async () => {
    expect(await ruleIds(fixture("web-imports-adapter.ts.txt"), "apps/web/src/fixture.ts")).toEqual(oneError());
  });

  it("rejects apps/server", async () => {
    expect(await ruleIds(`import "@tektum/grimoire-server";`, "apps/web/src/fixture.ts")).toEqual(oneError());
  });

  // The contracts file (section 1) does not say whether the client may use core, so core is allowed.
  it("allows core and the shared libraries", async () => {
    const code = `import "@tektum/grimoire-core/ports/logger";\nimport "@tektum/grimoire-api-client";\nimport "@tektum/grimoire-editor-schema";\nimport "yjs";`;
    expect(await errorsFor(code, "apps/web/src/fixture.ts")).toEqual([]);
  });
});

describe("packages/editor-schema and packages/api-client", () => {
  it.each(["packages/editor-schema/src/fixture.ts", "packages/api-client/src/fixture.ts"])("%s", async (file) => {
    for (const name of [...serverOnly, "@tektum/grimoire-adapter-db-kysely", "@tektum/grimoire-server", "@tektum/grimoire-web"]) {
      expect(await ruleIds(`import "${name}";`, file)).toEqual(oneError());
    }
    expect(await ruleIds(`await import("pg");`, file)).toEqual(oneError("no-restricted-syntax"));
    expect(await errorsFor(`import "@tektum/grimoire-core/ports/logger";\nimport "zod";`, file)).toEqual([]);
  });
});

describe("apps/server", () => {
  it("rejects an adapter factory import outside composition.ts (fixture)", async () => {
    expect(await ruleIds(fixture("server-imports-adapter-factory.ts.txt"), "apps/server/src/health/fixture.ts")).toEqual(oneError());
    expect(await ruleIds(`await import("@tektum/grimoire-adapter-db-kysely");`, "apps/server/src/app.ts")).toEqual(oneError("no-restricted-syntax"));
  });

  it("allows adapter imports as types outside composition.ts", async () => {
    expect(await errorsFor(fixture("server-imports-adapter-type.ts.txt"), "apps/server/src/health/fixture.ts")).toEqual([]);
    expect(await errorsFor(`import { type Database } from "@tektum/grimoire-adapter-db-kysely";\nexport type X = Database;`, "apps/server/src/app.ts")).toEqual([]);
  });

  it("allows core, adapters and composition in composition.ts (fixture)", async () => {
    expect(await errorsFor(fixture("composition-ok.ts.txt"), "apps/server/src/composition.ts")).toEqual([]);
  });

  it("allows core anywhere under apps/server/src", async () => {
    expect(await errorsFor(`import "@tektum/grimoire-core/ports/logger";\nimport "hono";`, "apps/server/src/app.ts")).toEqual([]);
  });

  // cli.ts is a second composition root (the migration command line); see the comment in eslint.config.js.
  it("allows adapter factories in cli.ts only as the named second composition root", async () => {
    expect(await errorsFor(fixture("server-imports-adapter-factory.ts.txt"), "apps/server/src/cli.ts")).toEqual([]);
    expect(await errorsFor(fixture("server-imports-adapter-factory.ts.txt"), "apps/server/src/cli2.ts")).toHaveLength(1);
  });
});

describe("the real tree", () => {
  it("lints clean", async () => {
    const results = await eslint.lintFiles(["apps", "packages"].filter((dir) => existsSync(at(dir))));
    const errors = results.flatMap((r) => r.messages.filter((m) => m.severity === 2).map((m) => `${path.relative(repoRoot, r.filePath)}: ${m.ruleId}`));
    expect(errors).toEqual([]);
  }, 120_000);
});

const scopes: [string, string][] = [
  ["core", "packages/core/src/fixture.ts"],
  ["an adapter", "packages/adapters/db-kysely/src/fixture.ts"],
  ["apps/web", "apps/web/src/fixture.ts"],
  ["apps/server/src", "apps/server/src/health/fixture.ts"],
  ["apps/server/src/composition.ts", "apps/server/src/composition.ts"],
  ["editor-schema", "packages/editor-schema/src/fixture.ts"],
  ["api-client", "packages/api-client/src/fixture.ts"],
];

describe("bare package subpaths that contain adapters/, apps/ or packages/", () => {
  it("allows crossws/adapters/node inside the collaboration adapter", async () => {
    expect(await errorsFor(`import "crossws/adapters/node";`, "packages/adapters/collab-hocuspocus/src/fixture.ts")).toEqual([]);
  });

  it.each(["apps/web/src/fixture.ts", "packages/core/src/fixture.ts", "packages/editor-schema/src/fixture.ts", "packages/api-client/src/fixture.ts"])(
    "still refuses crossws/adapters/node in %s (by the crossws rule)",
    async (file) => {
      expect(await ruleIds(`import "crossws/adapters/node";`, file)).toEqual(oneError());
    },
  );

  it("does not flag an unrelated package whose subpath names those words", async () => {
    const code = `import "some-lib/adapters/x";\nimport "other/packages/y";\nimport "@scope/lib/apps/z";`;
    expect(await errorsFor(code, "packages/adapters/collab-hocuspocus/src/fixture.ts")).toEqual([]);
    expect(await errorsFor(code, "apps/server/src/fixture.ts")).toEqual([]);
  });
});

describe("relative paths that name another package (lint; the scan in relative-imports.test.ts is the authority)", () => {
  it.each(scopes)("%s: rejects specifiers through packages/, apps/ and adapters/", async (_name, file) => {
    for (const spec of [
      "../../../packages/adapters/logger-json/src/index.js",
      "../../../apps/server/src/index.js",
      "../../adapters/logger-json/src/index.js",
      "../../../../adapters/logger-json/src/index.js",
      "../../packages/core/src/index.js",
    ]) {
      expect(await ruleIds(`import "${spec}";`, file), spec).toEqual(oneError());
    }
  });

  it.each(scopes)("%s: allows relative imports inside the package", async (_name, file) => {
    expect(await errorsFor(`import "./a.js";\nimport "../b.js";`, file)).toEqual([]);
  });

  it("rejects a value import of an adapter's source from apps/server/src", async () => {
    const spec = ["..", "..", "..", "packages", "adapters", "db-kysely", "src", "index.js"].join("/");
    expect(await ruleIds(`import { createDatabase } from ${JSON.stringify(spec)};`, "apps/server/src/app.ts")).toEqual(oneError());
  });
});

describe("non-literal dynamic imports and requires", () => {
  const bad = [
    "await import(`./${name}.js`);",
    "await import(name);",
    "await import(a + b);",
    "void require(name);",
    "void require(`x-${name}`);",
  ];
  it.each(scopes)("%s: rejects each form (exactly one error)", async (_name, file) => {
    for (const code of bad) expect(await ruleIds(code, file), code).toEqual(oneError("no-restricted-syntax"));
  });

  it.each(scopes)("%s: allows a literal dynamic import of an allowed module", async (_name, file) => {
    expect(await errorsFor(`await import("zod");\nvoid require("zod");\nawait import(\`zod\`);`, file)).toEqual([]);
  });

  it("refuses an expression-free template naming a restricted module by the module rules", async () => {
    expect(await ruleIds("await import(`pg`);", "packages/core/src/fixture.ts")).toEqual(oneError("no-restricted-syntax"));
    expect(await ruleIds("void require(`kysely`);", "packages/core/src/fixture.ts")).toEqual(oneError("no-restricted-syntax"));
    expect(await ruleIds("await import(`hono`);", "apps/web/src/fixture.ts")).toEqual(oneError("no-restricted-syntax"));
    expect(await ruleIds("await import(`@tektum/grimoire-adapter-logger-json`);", "packages/adapters/db-kysely/src/fixture.ts")).toEqual(oneError("no-restricted-syntax"));
    expect(await ruleIds("await import(`@tektum/grimoire-adapter-db-kysely`);", "apps/server/src/app.ts")).toEqual(oneError("no-restricted-syntax"));
  });

  it("exempts only the two named files that import a computed path", async () => {
    expect(await errorsFor("await import(file);", "packages/adapters/db-kysely/src/index.ts")).toEqual([]);
    expect(await errorsFor("await import(file);", "packages/core/test/boundaries/reference-excluded.test.ts")).toEqual([]);
    expect(await ruleIds("await import(file);", "packages/adapters/db-kysely/src/other.ts")).toEqual(oneError("no-restricted-syntax"));
    // the exemption does not lift the other rules for the same file
    expect(await ruleIds("await import('pg');", "packages/core/test/boundaries/reference-excluded.test.ts")).toEqual(oneError("no-restricted-syntax"));
  });

  it("applies to the migration command line as well", async () => {
    expect(await ruleIds("await import(file);", "apps/server/src/cli.ts")).toEqual(oneError("no-restricted-syntax"));
  });
});

describe("indirect loaders and code evaluation", () => {
  const forbiddenCode: [string, string, string][] = [
    ["createRequire (node:module)", `import { createRequire } from "node:module";\nexport const r = createRequire(import.meta.url);`, "no-restricted-imports"],
    ["createRequire (module)", `import { createRequire } from "module";\nexport const r = createRequire(import.meta.url);`, "no-restricted-imports"],
    ["createRequire as an alias", `import { createRequire as cr } from "node:module";\nexport const r = cr(import.meta.url);`, "no-restricted-imports"],
    ["module namespace", `import * as m from "node:module";\nexport const r = m.createRequire(import.meta.url);`, "no-restricted-imports"],
    ["module default", `import m from "node:module";\nexport const r = m.createRequire(import.meta.url);`, "no-restricted-imports"],
    ["process.mainModule", `export const r = process.mainModule?.require("x");`, "no-restricted-syntax"],
    ["process['mainModule']", `export const r = process["mainModule"];`, "no-restricted-syntax"],
    ["eval", `eval("1");`, "no-restricted-syntax"],
    ["globalThis.eval", `globalThis.eval("1");`, "no-restricted-syntax"],
    ["new Function", `export const f = new Function("return 1");`, "no-restricted-syntax"],
    ["Function call", `export const f = Function("return 1");`, "no-restricted-syntax"],
  ];
  it.each(scopes)("%s: rejects each form", async (_name, file) => {
    for (const [label, code, rule] of forbiddenCode) {
      const errors = await ruleIds(code, file);
      expect(errors.length, label).toBeGreaterThan(0);
      expect(new Set(errors), label).toEqual(new Set([rule]));
    }
  });

  it.each(scopes)("%s: allows ordinary code that mentions the names", async (_name, file) => {
    expect(await errorsFor(`import { builtinModules } from "node:fs";\nexport const o = { eval: 1, Function: 2 };\nexport const n = process.argv;`, file)).toEqual([]);
  });

  it("applies to the migration command line; the two exempt files lose the whole syntax group (eval included)", async () => {
    expect((await ruleIds(`eval("1");`, "apps/server/src/cli.ts")).length).toBe(1);
    expect((await ruleIds(`eval("1");`, "packages/core/test/boundaries/reference-excluded.test.ts")).length).toBe(0);
  });
});
