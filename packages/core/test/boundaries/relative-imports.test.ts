import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./paths.js";

/** Every module specifier in a source text, from the TypeScript parser: import and export declarations,
 * `import x = require()`, `import()` and `require()` calls, and `import("x").T` types. Non-literal arguments are
 * the lint rule's business. */
export function moduleSpecifiers(text: string, fileName = "file.ts"): string[] {
  const out: string[] = [];
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const add = (node: ts.Node | undefined) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) out.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Specifiers that leave `packageDir` when imported from `file`: a relative path that resolves outside, a `file:` URL,
 * an absolute path, or anything naming node_modules. */
export function escapingSpecifiers(text: string, file: string, packageDir: string): string[] {
  return moduleSpecifiers(text, file).filter((spec) => {
    if (/^file:/i.test(spec) || spec.includes("node_modules") || path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return true;
    if (!spec.startsWith(".")) return false;
    const rel = path.relative(packageDir, path.resolve(path.dirname(file), spec));
    return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  });
}

const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { workspaces: string[] };
function packageDirs(): string[] {
  const dirs: string[] = [];
  for (const glob of rootPackage.workspaces) {
    const parent = path.join(repoRoot, glob.slice(0, -2));
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const dir = path.join(parent, entry.name);
      if (entry.isDirectory() && existsSync(path.join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return dirs;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // Only the boundary tests' own deliberately bad inputs are not scanned; every other fixtures directory is a real source and is.
    if (["node_modules", "dist", "coverage"].includes(entry.name) || full === path.join(repoRoot, "packages/core/test/boundaries/fixtures")) continue;
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(?:[cm]?[tj]sx?)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

describe("relative imports stay inside their package (scan)", () => {
  it("finds the workspace packages", () => {
    expect(packageDirs().length).toBe(17);
  });

  it("resolves every relative specifier in every workspace package (src and test) inside that package", () => {
    const offenders: string[] = [];
    for (const dir of packageDirs()) {
      for (const file of sourceFiles(dir)) {
        const repoRel = path.relative(repoRoot, file).split(path.sep).join("/");
        for (const spec of escapingSpecifiers(readFileSync(file, "utf8"), file, dir)) offenders.push(`${repoRel}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  }, 30_000); // CPU-bound: it reads every source file of the repository once; a loaded machine needs more than vitest's 5 s. No wall-clock assertion.

  const pkg = path.join(repoRoot, "packages/adapters/db-kysely");
  const file = path.join(pkg, "src/index.ts");
  it.each([
    ["adapter into another adapter", "../../logger-json/src/index.js"],
    ["adapter into another adapter, deeper", "../../../adapters/logger-json/src/index.js"],
    ["adapter into apps", "../../../../apps/server/src/index.js"],
    ["adapter into another package", "../../../core/src/index.js"],
    ["out of the package by the package root", "../../x"],
  ])("flags %s", (_n, spec) => {
    for (const code of [`import x from "${spec}";`, `export * from "${spec}";`, `await import("${spec}");`, `require("${spec}");`]) {
      expect(escapingSpecifiers(code, file, pkg)).toEqual([spec]);
    }
  });

  it("flags a climb out of apps/web, editor-schema and api-client", () => {
    for (const [dir, spec, escapesFromDeeper] of [
      ["apps/web", "../../server/src/index.js", false],
      ["apps/web", "../../../packages/adapters/db-kysely/src/index.js", true],
      ["packages/editor-schema", "../../adapters/db-kysely/src/index.js", false],
      ["packages/api-client", "../../../apps/server/src/index.js", true],
    ] as const) {
      const base = path.join(repoRoot, dir);
      expect(escapingSpecifiers(`import "${spec}";`, path.join(base, "src/a.ts"), base)).toEqual([spec]);
      // One directory deeper the same text escapes or not as the path arithmetic says (exact, per case); one more "../" always leaves the package.
      expect(escapingSpecifiers(`import "${spec}";`, path.join(base, "src/a/b.ts"), base)).toEqual(escapesFromDeeper ? [spec] : []);
      expect(escapingSpecifiers(`import "../${spec}";`, path.join(base, "src/a/b.ts"), base)).toEqual([`../${spec}`]);
    }
  });

  it("allows relative imports that stay inside the package", () => {
    const code = `import a from "./a.js";\nimport b from "../src/b.js";\nawait import("./sub/c.js");\nexport * from "../test/d.js";`;
    expect(escapingSpecifiers(code, path.join(pkg, "test/x.test.ts"), pkg)).toEqual([]);
  });

  it("ignores bare package specifiers", () => {
    expect(escapingSpecifiers(`import "@tektum/grimoire-core";\nimport "node:path";`, file, pkg)).toEqual([]);
  });

  const bypass = "../../../packages/adapters/logger-json/dist/index.js";
  it.each([
    ["block comment before a dynamic import", `await import(/* c */ "${bypass}");`],
    ["line comment before a dynamic import", `await import(\n// c\n"${bypass}");`],
    ["block comment in a static import", `import x from /* c */ "../../web/src/index.js";`],
    ["export from with a comment", `export * from /* c */ "../../web/src/index.js";`],
    ["import equals", `import x = require("../../web/src/index.js");`],
    ["import type", `type T = import("../../web/src/index.js").X;`],
    ["template literal without expressions", "await import(`../../web/src/index.js`);"],
  ])("flags %s", (_n, code) => {
    expect(escapingSpecifiers(code, file, pkg)).toHaveLength(1);
  });

  it.each([
    "file:///x/packages/adapters/logger-json/dist/index.js",
    "/abs/path/to/x.js",
    "C:/x/y.js",
    "../node_modules/x/index.js",
    "some/node_modules/pkg",
  ])("flags the specifier %s", (spec) => {
    expect(escapingSpecifiers(`import("${spec}");\nrequire("${spec}");`, file, pkg)).toEqual([spec, spec]);
  });

  it("does not match inside strings or comments", () => {
    const code = `const s = 'import x from "../../web/src/index.js"';\nconst t = "await import(\\"../../web/src/index.js\\")";\n// import "../../web/src/index.js";\n/* require("../../web/src/index.js") */`;
    expect(moduleSpecifiers(code)).toEqual([]);
  });

  it("covers core, apps and every adapter package as the importing package", () => {
    const dirs = packageDirs().map((d) => path.relative(repoRoot, d).split(path.sep).join("/"));
    for (const name of ["packages/core", "apps/web", "apps/server", "packages/editor-schema", "packages/api-client"]) expect(dirs).toContain(name);
    const adapterDirs = dirs.filter((d) => d.startsWith("packages/adapters/"));
    expect(adapterDirs).toHaveLength(11);
    for (const rel of dirs) {
      const dir = path.join(repoRoot, rel);
      const from = path.join(dir, "src/deep/x.ts");
      expect(escapingSpecifiers(`import "../../../x.js";\nawait import("../../../../zzz/a.js");`, from, dir)).toHaveLength(2);
      expect(escapingSpecifiers(`import "../a.js";\nimport "./b.js";`, from, dir)).toEqual([]);
      expect(escapingSpecifiers(`await import(/* c */ "../../../../zzz/x.js");`, from, dir)).toHaveLength(1);
    }
  });
});
