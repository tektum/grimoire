import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./paths.js";

const probes = [
  "reference/relay/src/index.ts",
  "reference/spike/test/a.test.ts",
  "reference/spike/test/a.int.test.ts",
  "reference/tests/a.container.test.ts",
];

type TsConfig = { include?: string[]; files?: string[]; exclude?: string[] };

/** Whether a tsconfig in `dir` would compile the repository-relative `probe` (a config with neither `include` nor `files` is only extended, so it compiles nothing itself). */
function compiles(dir: string, config: TsConfig, probe: string): boolean {
  if (config.include === undefined && config.files === undefined) return false;
  const rel = path.relative(dir, path.join(repoRoot, probe)).split(path.sep).join("/");
  const matches = (glob: string) => path.matchesGlob(rel, glob) || path.matchesGlob(rel, `${glob.replace(/\/$/, "")}/**`);
  const excluded = (config.exclude ?? []).some(matches);
  // `exclude` filters only what `include` matches; a file listed in `files` is always compiled.
  return (config.files ?? []).some((f) => path.resolve(dir, f) === path.join(repoRoot, probe)) || (!excluded && (config.include ?? []).some(matches));
}

function tsconfigFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "reference" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsconfigFiles(full));
    else if (/^tsconfig.*\.json$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("compiles(): what a tsconfig compiles, as TypeScript decides it", () => {
  it("`exclude` filters only what `include` matches: a file listed in `files` is compiled whatever `exclude` says", () => {
    const dir = path.join(repoRoot, "packages/x");
    expect(compiles(dir, { files: ["../../reference/relay/src/index.ts"], exclude: ["../../reference"] }, "reference/relay/src/index.ts")).toBe(true);
    expect(compiles(dir, { include: ["../../reference/**/*.ts"], exclude: ["../../reference"] }, "reference/relay/src/index.ts")).toBe(false);
    expect(compiles(dir, { include: ["src"], files: [] }, "reference/relay/src/index.ts")).toBe(false);
  });
});

describe("reference/ is excluded", () => {
  it("is ignored by the ESLint config", async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    for (const probe of probes) {
      expect(await eslint.isPathIgnored(path.join(repoRoot, probe)), probe).toBe(true);
    }
  });

  it("is not matched by any tsconfig include or file list", () => {
    const files = tsconfigFiles(repoRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const config = JSON.parse(readFileSync(file, "utf8")) as TsConfig;
      for (const probe of probes) expect(compiles(path.dirname(file), config, probe), `${file} compiles ${probe}`).toBe(false);
    }
  });

  it("the tsconfig matcher catches wildcard includes, file lists and honours exclude", () => {
    const dir = path.join(repoRoot, "packages/core");
    const probe = "reference/relay/src/index.ts";
    expect(compiles(repoRoot, { include: ["**/*.ts"] }, probe)).toBe(true);
    expect(compiles(repoRoot, { include: ["reference"] }, probe)).toBe(true);
    expect(compiles(repoRoot, { files: [probe] }, probe)).toBe(true);
    expect(compiles(repoRoot, { include: ["**/*.ts"], exclude: ["reference"] }, probe)).toBe(false);
    expect(compiles(dir, { include: ["src", "test"] }, probe)).toBe(false);
    expect(compiles(dir, { include: ["../../**/*.ts"] }, probe)).toBe(true);
  });

  it("is not matched by any vitest include", async () => {
    const module: unknown = await import(pathToFileURL(path.join(repoRoot, "vitest.config.js")).href);
    const config = (module as { default: { test: { projects: { test: { include: string[]; exclude: string[] } }[] } } }).default;
    expect(config.test.projects.length).toBe(4);
    for (const project of config.test.projects) {
      expect(project.test.exclude).toContain("reference/**");
      for (const include of project.test.include) {
        for (const probe of probes) expect(path.matchesGlob(probe, include), `${include} vs ${probe}`).toBe(false);
      }
    }
  });

  it("keeps the converter benchmark out of the unit project and in a project of its own", async () => {
    const module: unknown = await import(pathToFileURL(path.join(repoRoot, "vitest.config.js")).href);
    type Project = { test: { name: string; include: string[]; exclude: string[] } };
    const projects = (module as { default: { test: { projects: Project[] } } }).default.test.projects;
    const probe = "packages/adapters/markdown-milkdown/test/benchmark/size.test.ts";
    const runs = projects.filter(
      (project) =>
        project.test.include.some((glob) => path.matchesGlob(probe, glob)) &&
        !project.test.exclude.some((glob) => path.matchesGlob(probe, glob)),
    );
    expect(runs.map((project) => project.test.name)).toEqual(["benchmark"]);
  });

  it("is not matched by any workspace glob", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { workspaces: string[] };
    const referenceDirs = existsSync(path.join(repoRoot, "reference"))
      ? readdirSync(path.join(repoRoot, "reference")).map((name) => `reference/${name}`)
      : [];
    for (const glob of pkg.workspaces) {
      for (const dir of ["reference", "reference/relay", ...referenceDirs]) {
        expect(path.matchesGlob(dir, glob), `${glob} vs ${dir}`).toBe(false);
      }
    }
  });
});
