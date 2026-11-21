import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const forbiddenModules = [
  "@aws-sdk",
  "@descope",
  "@hocuspocus",
  "@hono",
  "pg",
  "kysely",
  "pg-boss",
  "hono",
  "ws",
  "crossws",
  "pino",
  "rate-limiter-flexible",
  "yjs",
  "y-protocols",
];

const importSpecifier = /\b(?:from|import|require)\s*\(?\s*(["'])([^"']+)\1/g;
const envRead = /\bprocess\s*(?:\.\s*env\b|\[\s*["']env["']\s*\])/;
const envDestructure = /\{[^}]*\benv\b[^}]*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/;
const processNamedEnvImport = /\bimport\s*(?:[\w$]+\s*,\s*)?\{[^}]*\benv\b[^}]*\}\s*from\s*["'](?:node:)?process["']/;
const processAliasImport = /\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\b[^;"']*from\s*["'](?:node:)?process["']/g;

/** Returns one message per forbidden import or environment read found in the source text. */
export function scanSource(text: string): string[] {
  const found: string[] = [];

  for (const match of text.matchAll(importSpecifier)) {
    const specifier = match[2] ?? "";
    if (forbiddenModules.some((m) => specifier === m || specifier.startsWith(`${m}/`))) {
      found.push(`imports ${specifier}`);
    }
  }

  if (envRead.test(text)) found.push("reads process.env");
  if (envDestructure.test(text)) found.push("destructures env from process");
  if (processNamedEnvImport.test(text)) found.push("imports env from the process module");
  for (const match of text.matchAll(processAliasImport)) {
    const alias = match[1] ?? "";
    if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\.\\s*env\\b`).test(text)) {
      found.push(`reads env through the process module import ${alias}`);
    }
  }
  return found;
}

export function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Scans every TypeScript file under a directory; keys are paths relative to it. */
export function scanDirectory(dir: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const file of listTsFiles(dir)) {
    const found = scanSource(readFileSync(file, "utf8"));
    if (found.length > 0) result[path.relative(dir, file)] = found;
  }
  return result;
}
