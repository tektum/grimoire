import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./paths.js";

const expectedNames = [
  "@tektum/grimoire-core",
  "@tektum/grimoire-server",
  "@tektum/grimoire-editor-schema",
  "@tektum/grimoire-api-client",
  "@tektum/grimoire-web",
  ...["auth-descope", "config-env", "logger-json", "db-kysely", "auth-dev", "auth-fake", "collab-hocuspocus", "markdown-milkdown", "jobs-pgboss", "files-s3", "embedder-onnx"].map(

    (a) => `@tektum/grimoire-adapter-${a}`,
  ),
  "@tektum/grimoire-test-support",
].sort();


const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  engines: { node: string };
  workspaces: string[];
};

const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
type Manifest = Partial<Record<(typeof dependencyFields)[number], Record<string, string>>>;

/** Deliberate exceptions to "one package per library", each with its reason. */
const sameCopy = "the converter must load the same copy as the schema package and the collaboration adapter; versions pinned identically";
const allowedDuplicates: Record<string, string> = {
  "@hocuspocus/provider": "the collaboration adapter and its shared test client must use the same provider transport; versions pinned identically",
  "@hocuspocus/server": "the shared test client's own test (connect.int.test.ts) needs a minimal in-process collaboration server of the same library the adapter runs; versions pinned identically",
  jose: "server exit tests sign Descope tokens with the same jose library used by the adapter to verify them, pinned identically",
  yjs: sameCopy,
  "@milkdown/core": sameCopy,
  "@milkdown/ctx": sameCopy,
  // Not in the contracts file. editor-schema's tests (two-editors, fragment-name, yjs-losses, headings, size benchmark)
  // must live in editor-schema and each needs these libraries; the converter needs them too.
  "y-prosemirror": "editor-schema tests write the Yjs fragment (y-prosemirror); the converter reads it at run time",
  // The web client mounts the editor in the browser: it loads the same copy of the editor libraries as the schema package, pinned identically.
  "@milkdown/preset-commonmark": "the web client's editor loads the same copy as the schema package; versions pinned identically",
  "@milkdown/preset-gfm": "the web client's editor loads the same copy as the schema package; versions pinned identically",
  "@milkdown/prose": "the web client's editor loads the same copy as the schema package; versions pinned identically",
  "@milkdown/utils": "the web client's editor loads the same copy as the schema package; versions pinned identically",
  "@milkdown/plugin-collab": "editor-schema two-editors and fragment-name tests bind the collab plugin; converter parity tests too",
  "happy-dom": "editor-schema tests run a real editor, which needs a DOM; converter parity tests too",
  zod: "one copy, same pin as the other declaration",
  "rate-limiter-flexible": "one copy, same pin as the other declaration",
};

function allManifests(): { file: string; manifest: Manifest }[] {
  const files = ["package.json"];
  for (const glob of rootPackage.workspaces) {
    const parent = path.join(repoRoot, glob.slice(0, -2));
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const rel = path.join(glob.slice(0, -2), entry.name, "package.json");
      if (entry.isDirectory() && existsSync(path.join(repoRoot, rel))) files.push(rel);
    }
  }
  return files.map((file) => ({ file, manifest: JSON.parse(readFileSync(path.join(repoRoot, file), "utf8")) as Manifest }));
}

function declared(manifest: Manifest): [string, string, string][] {
  return dependencyFields.flatMap((field) => Object.entries(manifest[field] ?? {}).map(([n, v]): [string, string, string] => [field, n, v]));
}

/** Workspace globs in this repository are all of the form `<dir>/*`. */
function workspaceNames(): string[] {
  const names: string[] = [];
  for (const glob of rootPackage.workspaces) {
    expect(glob).toMatch(/^[\w./-]+\/\*$/);
    const parent = path.join(repoRoot, glob.slice(0, -2));
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const manifest = path.join(parent, entry.name, "package.json");
      if (entry.isDirectory() && existsSync(manifest)) {
        names.push((JSON.parse(readFileSync(manifest, "utf8")) as { name: string }).name);
      }
    }
  }
  return names.sort();
}

describe("repository layout", () => {
  it("pins Node 26 in mise.toml (the single source of tool versions) and engines", () => {
    expect(readFileSync(path.join(repoRoot, "mise.toml"), "utf8")).toMatch(/^node\s*=\s*"26"\s*$/m);
    expect(rootPackage.engines.node).toBe(">=26 <27");
  });

  // bun is the package manager (Node stays the runtime): one version in mise.toml, the same one in the Dockerfile's bun stage.
  it("pins bun once in mise.toml and the same version in the Dockerfile, which keeps bun out of the final image", () => {
    const pinned = /^bun\s*=\s*"(\d+\.\d+\.\d+)"/m.exec(readFileSync(path.join(repoRoot, "mise.toml"), "utf8"))?.[1];
    expect(pinned).toBeDefined();
    const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    expect(/^FROM oven\/bun:(\d+\.\d+\.\d+)-slim@sha256:[0-9a-f]{64} AS bun$/m.exec(dockerfile)?.[1]).toBe(pinned);
    const finalStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    expect(finalStage).not.toMatch(/bun/i);
  });

  it("locks with bun.lock only, installs hoisted, and trusts no dependency's install script", () => {
    expect(existsSync(path.join(repoRoot, "bun.lock"))).toBe(true);
    for (const f of [`${"package"}-lock.json`, "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"]) expect(existsSync(path.join(repoRoot, f))).toBe(false);
    expect(readFileSync(path.join(repoRoot, "bunfig.toml"), "utf8")).toMatch(/^linker\s*=\s*"hoisted"\s*$/m);
    // Only the root list counts to bun. It must exist and be empty: without the field bun runs the install scripts of its built-in default list.
    expect(rootPackage).toHaveProperty("trustedDependencies", []);
    for (const { file, manifest } of allManifests().filter((m) => m.file !== "package.json")) expect(manifest, file).not.toHaveProperty("trustedDependencies");
  });

  it("calls no script through the Node package manager or its runner", () => {
    for (const { file, manifest } of allManifests()) {
      for (const [name, command] of Object.entries((manifest as { scripts?: Record<string, string> }).scripts ?? {}))
        expect(command, `${file} script ${name}`).not.toMatch(/\bnp(?:m|x)\b/);
    }
  });

  it("has exactly the workspace packages of the contracts file", () => {
    expect(workspaceNames()).toEqual(expectedNames);
  });

  it("names every package with the @tektum/grimoire- scope", () => {
    for (const name of workspaceNames()) expect(name).toMatch(/^@tektum\/grimoire-[a-z0-9-]+$/);
  });

  it("keeps deployables in apps/ and libraries in packages/", () => {
    expect(readdirSync(path.join(repoRoot, "apps")).sort()).toEqual(["server", "web"]);
    expect(existsSync(path.join(repoRoot, "packages/server"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "packages/app"))).toBe(false);
  });

  // Workspace-internal references are written `*`: bun links the workspace folder whatever its version, so there is
  // nothing to pin, and `*` cannot resolve to a registry package because the names are workspace members.
  it("pins every dependency of every package.json to an exact version", () => {
    const internal = new Set(workspaceNames());
    for (const { file, manifest } of allManifests()) {
      for (const [field, name, spec] of declared(manifest)) {
        const where = `${file} ${field} ${name}@${spec}`;
        if (name.startsWith("@tektum/grimoire-")) {
          expect(internal.has(name), where).toBe(true);
          expect(spec, where).toBe("*");
        } else {
          expect(spec, where).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
        }
      }
    }
  });

  it("declares each third-party library in exactly one package.json", () => {
    const places = new Map<string, Set<string>>();
    const specs = new Map<string, Set<string>>();
    for (const { file, manifest } of allManifests()) {
      for (const [, name, spec] of declared(manifest)) {
        if (name.startsWith("@tektum/grimoire-")) continue;
        places.set(name, (places.get(name) ?? new Set()).add(file));
        specs.set(name, (specs.get(name) ?? new Set()).add(spec));
      }
    }
    // The reasons above say "pinned identically" so that one copy loads: a version bumped in one manifest only breaks that, and is caught here.
    for (const name of Object.keys(allowedDuplicates)) if ((places.get(name)?.size ?? 0) > 1) expect([...(specs.get(name) ?? [])], `${name} must have one version everywhere`).toHaveLength(1);
    const duplicates = [...places].filter(([name, files]) => files.size > 1 && !allowedDuplicates[name]);
    expect(duplicates.map(([name, files]) => `${name}: ${[...files].join(", ")}`)).toEqual([]);
  });
});

describe("test:conformance script", () => {
  const script = (JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["test:conformance"] ?? "";

  it("filters on the word, passes with no match yet, and never runs the container or benchmark projects", () => {
    expect(script).toMatch(/\bconformance$/);
    expect(script).toContain("--passWithNoTests");
    expect(script).toContain("--project unit");
    expect(script).not.toMatch(/container|benchmark/);
  });
});

describe("file storage dependencies", () => {
  // Versions are not repeated here: Renovate bumps the manifest and the lockfile, and this checks they agree.
  const expected: [string, string][] = [
    ["packages/adapters/files-s3/package.json", "@aws-sdk/client-s3"],
    ["packages/adapters/files-s3/package.json", "@aws-sdk/s3-request-presigner"],
    ["packages/adapters/files-s3/package.json", "content-disposition"],
    ["apps/server/package.json", "file-type"],
    ["package.json", "@playwright/test"],
  ];
  const lock = readFileSync(path.join(repoRoot, "bun.lock"), "utf8");

  it("declares each package in the one manifest that owns it, and the lockfile resolves it to the declared version", () => {
    for (const [file, name] of expected) {
      const manifest = JSON.parse(readFileSync(path.join(repoRoot, file), "utf8")) as Manifest;
      const version = declared(manifest).find(([, n]) => n === name)?.[2];
      expect(version, `${file} declares ${name}`).toBeDefined();
      expect(lock, `${name}@${version} in bun.lock`).toContain(`"${name}": ["${name}@${version}"`);
    }
  });
});
