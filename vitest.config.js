import { defineConfig } from "vitest/config";

const exclude = ["**/node_modules/**", "**/dist/**", "**/coverage/**", "reference/**"];
const slow = ["**/*.int.test.ts", "**/*.container.test.ts"];
// The converter benchmark takes minutes: it has its own project and script (`bun run test:benchmark`), never `bun run test`.
const benchmark = ["**/test/benchmark/**"];

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      enabled: false, // switched on by `bun run test:coverage`; the plain `bun run test` stays fast
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      // Every real source file counts, tested or not: an untested file shows as 0%, it is never silently left out.
      include: ["{apps,packages}/**/src/**/*.ts"],
      exclude: [
        ...exclude,
        "**/*.test.ts", // tests
        "**/*.d.ts", // type declarations: no code
        "**/test/**", // tests and their helpers
        "**/test-e2e/**", // end-to-end scenarios (run in containers)
        "**/fixtures/**", // sample inputs
        "packages/test-support/**", // test helpers, not shipped code
        "**/src/testing/**", // test doubles and generators shipped for tests only
        "**/src/test-facilities.ts", // test-only facilities of the config adapter
      ],
      // Floors set from the measured baseline (2026-11-21, unit project only), a point or so below it. They are a ratchet:
      // `COVERAGE_RATCHET=1 bun run test:coverage` rewrites them upwards when coverage has grown; they never go down
      // except by a reviewed edit of this file. A `/* v8 ignore */` or an exclusion above needs a reason on the same line.
      thresholds: {
        autoUpdate: process.env.COVERAGE_RATCHET === "1",
        statements: 86,
        branches: 84,
        functions: 82,
        lines: 87,
        "packages/core/src/**": { statements: 98, branches: 96, functions: 100, lines: 100 },
        "packages/editor-schema/src/**": { statements: 95, branches: 87, functions: 96, lines: 96 },
        "packages/adapters/auth-descope/src/**": { statements: 99, branches: 98, functions: 100, lines: 100 },
        "packages/adapters/config-env/src/**": { statements: 98, branches: 96, functions: 98, lines: 98 },
        "packages/adapters/logger-json/src/**": { statements: 99, branches: 97, functions: 96, lines: 98 },
        "packages/adapters/markdown-milkdown/src/**": { statements: 91, branches: 85, functions: 94, lines: 92 },
        // db-kysely is exercised only by the integration project (needs Postgres): no unit floor until that is collected.
        "packages/core/src/authorize/decide.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/adapters/logger-json/src/scrub.ts": { statements: 100, branches: 98, functions: 100, lines: 100 },
        "packages/adapters/auth-descope/src/index.ts": { statements: 99, branches: 98, functions: 100, lines: 100 },
      },
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["{apps,packages}/**/{src,test}/**/*.test.ts"],
          exclude: [...exclude, ...slow, ...benchmark],
        },
      },
      {
        test: {
          name: "benchmark",
          include: ["{apps,packages}/**/test/benchmark/**/*.test.ts"],
          exclude,
        },
      },
      {
        test: {
          name: "integration",
          include: ["{apps,packages}/**/{src,test}/**/*.int.test.ts"],
          exclude,
        },
      },
      {
        test: {
          name: "container",
          include: ["{apps,packages}/**/{src,test}/**/*.container.test.ts"],
          exclude,
        },
      },
    ],
  },
});
