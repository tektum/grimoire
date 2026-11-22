import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { repoRoot } from "./paths.js";

// An adapter's `/testing` subpath holds test facilities (for example a saver whose breaker can be switched off). Tests may import it; no production
// source file may, whichever package it is in.
const isTestingSubpath = (spec: string): boolean => /^@tektum\/grimoire-adapter-[\w-]+\/testing(?:\/|$)/.test(spec);

/** Every literal module specifier of a text (import/export declarations, import(), require(), import types), from the TypeScript parser. */
function moduleSpecifiers(text: string, fileName = "file.ts"): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    const lit = (n: ts.Node | undefined) => { if (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))) out.push(n.text); };
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) lit(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) lit(node.argument.literal);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) lit(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true));
  return out;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

describe("the testing subpath of an adapter", () => {
  it("is recognised in the forms an import can take", () => {
    for (const s of ["@tektum/grimoire-adapter-collab-hocuspocus/testing", "@tektum/grimoire-adapter-x/testing/deep"]) expect(isTestingSubpath(s)).toBe(true);
    for (const s of ["@tektum/grimoire-adapter-collab-hocuspocus", "@tektum/grimoire-core/testing/fake-logger", "@tektum/grimoire-adapter-x/testing-not"]) expect(isTestingSubpath(s)).toBe(false);
  });

  it("is imported by no production source file (every src/ directory of apps and packages)", () => {
    const roots = [
      ...readdirSync(path.join(repoRoot, "apps")).map((d) => path.join(repoRoot, "apps", d, "src")),
      ...readdirSync(path.join(repoRoot, "packages")).map((d) => path.join(repoRoot, "packages", d, "src")),
      ...readdirSync(path.join(repoRoot, "packages/adapters")).map((d) => path.join(repoRoot, "packages/adapters", d, "src")),
    ];
    const offenders = roots.flatMap(sourceFiles).filter((f) => moduleSpecifiers(readFileSync(f, "utf8"), f).some(isTestingSubpath));
    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });

  it("the scan sees a violation (a source text that imports it)", () => {
    expect(moduleSpecifiers(`import { createSaver } from "@tektum/grimoire-adapter-collab-hocuspocus/testing";`).some(isTestingSubpath)).toBe(true);
    expect(moduleSpecifiers(`const m = await import("@tektum/grimoire-adapter-collab-hocuspocus/testing");`).some(isTestingSubpath)).toBe(true);
  });
});
