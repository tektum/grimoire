import { describe, expect, it } from "vitest";
import { coreSrc, fixture } from "./paths.js";
import { listTsFiles, scanDirectory, scanSource } from "./scan.js";

describe("core scan", () => {
  it("reports a fixture containing process.env.X", () => {
    expect(scanSource(fixture("forbidden-env.ts.txt"))).toEqual(["reads process.env"]);
  });

  it.each([
    "forbidden-pg.ts.txt",
    "forbidden-kysely.ts.txt",
    "forbidden-pg-boss.ts.txt",
    "forbidden-aws-sdk-client-s3.ts.txt",
    "forbidden-descope-node-sdk.ts.txt",
    "forbidden-hocuspocus-server.ts.txt",
    "forbidden-pino.ts.txt",
    "forbidden-rate-limiter-flexible.ts.txt",
    "forbidden-yjs.ts.txt",
    "forbidden-y-protocols.ts.txt",
  ])("reports a fixture with a forbidden import: %s", (file) => {
    expect(scanSource(fixture(file)).length).toBe(1);
  });

  it("accepts zod in the core", () => {
    expect(scanSource(fixture("allowed-zod.ts.txt"))).toEqual([]);
  });

  it("reports import { env } from \"node:process\"", () => {
    expect(scanSource(fixture("env-named-import.ts.txt"))).toEqual(["imports env from the process module"]);
  });

  it("reports import process from \"node:process\" followed by process.env", () => {
    expect(scanSource(fixture("env-default-import.ts.txt"))).toContain("reads process.env");
  });

  it("reports an aliased namespace import of the process module followed by .env", () => {
    expect(scanSource(fixture("env-namespace-alias.ts.txt"))).toEqual([
      "reads env through the process module import proc",
    ]);
  });

  it("reports destructuring env from process", () => {
    expect(scanSource(fixture("env-destructure.ts.txt"))).toEqual(["destructures env from process"]);
  });

  it("reports nothing for a clean fixture", () => {
    expect(scanSource(fixture("clean.ts.txt"))).toEqual([]);
  });

  it("reports nothing for packages/core/src", () => {
    expect(listTsFiles(coreSrc).length).toBeGreaterThan(0);
    expect(scanDirectory(coreSrc)).toEqual({});
  });
});
