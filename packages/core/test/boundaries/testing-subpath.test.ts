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

/**
 * The text with its well-formed escape sequences decoded the way a string literal or an identifier is (an identity escape such as \e gives e, a line continuation
 * goes): a specifier spelled with escapes is then a plain substring, so the text filter below never skips what the parser sees. Only well-formed escapes are decoded,
 * because a lax pattern would let an unfinished \u{ in a comment swallow the code up to the next }. \n gives n rather than a newline, which only lets more texts through.
 */
function decodeEscapes(text: string): string {
  return text.replace(
    /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-7]{1,3})|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/g,
    (_all, braced?: string, u4?: string, x2?: string, octal?: string, newline?: string, other?: string) =>
      braced !== undefined
        ? String.fromCodePoint(Math.min(parseInt(braced, 16), 0x10ffff))
        : (u4 ?? x2) !== undefined
          ? String.fromCharCode(parseInt((u4 ?? x2) as string, 16))
          : octal !== undefined
            ? String.fromCharCode(parseInt(octal, 8))
            : newline !== undefined
              ? ""
              : (other as string),
  );
}

/**
 * Whether a source text imports the testing subpath. The parser runs only on a text that names `/testing` once its escapes are decoded (2 of the 425 production files
 * today): parsing every file took about 0.4 s idle and passed the 5 s default under a loaded test run.
 */
const importsTestingSubpath = (text: string, fileName?: string): boolean => decodeEscapes(text).includes("/testing") && moduleSpecifiers(text, fileName).some(isTestingSubpath);

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
    const offenders = roots.flatMap(sourceFiles).filter((f) => importsTestingSubpath(readFileSync(f, "utf8"), f));
    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });

  it("the scan sees a specifier spelled with escape sequences, which the parser decodes", () => {
    const spelled = [
      'import { s } from "@tektum/grimoire-adapter-x/test\\u0069ng";',
      'import { s } from "@tektum/grimoire-adapter-x/t\\x65sting";',
      'import { s } from "@tektum/grimoire-adapter-x/t\\esting";', // an identity escape
      'import { s } from "@tektum/grimoire-adapter-x/test\\\ning";', // a line continuation
      // An unfinished escape in a comment must not swallow the code after it (a namespace import: its own braces would end the escape early).
      '// an unfinished escape in a comment: \\u{ and \\x\nimport * as s from "@tektum/grimoire-adapter-x/testing"; // }',
    ];
    for (const text of spelled) expect(importsTestingSubpath(text), text).toBe(true);
  });

  it("the scan sees a violation (a source text that imports it)", () => {
    expect(importsTestingSubpath(`import { createSaver } from "@tektum/grimoire-adapter-collab-hocuspocus/testing";`)).toBe(true);
    expect(importsTestingSubpath(`const m = await import("@tektum/grimoire-adapter-collab-hocuspocus/testing");`)).toBe(true);
    expect(importsTestingSubpath(`export type { Saver } from "@tektum/grimoire-adapter-x/testing/deep";`)).toBe(true);
    expect(importsTestingSubpath(`import { createSaver } from "@tektum/grimoire-adapter-collab-hocuspocus";\n// see /testing for the fake`)).toBe(false);
  });
});
