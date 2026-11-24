import { defineConfig } from "vitest/config";

const exclude = ["**/node_modules/**", "**/dist/**", "**/coverage/**", "reference/**"];
const slow = ["**/*.int.test.ts", "**/*.container.test.ts"];
// The converter benchmark takes minutes: it has its own project and script (`bun run test:benchmark`), never `bun run test`.
const benchmark = ["**/test/benchmark/**"];
// The web client's tests run in their own project (a browser-like environment); the unit project must not match them.
const web = ["apps/web/**"];
// Files that only the integration project covers, because they need a database. The unit run leaves them out of its coverage and
// floors; the integration run and the merged run (vitest.integration-coverage.config.js, vitest.merged-coverage.config.js) count them.
export const integrationCovered = [
  "packages/adapters/db-kysely/src/idempotency.ts", // integration tests: packages/adapters/db-kysely/test/idempotency
  "packages/adapters/db-kysely/src/collections.ts", // integration tests: packages/adapters/db-kysely/test/collections
  "packages/adapters/db-kysely/src/audit.ts", // integration tests: packages/adapters/db-kysely/test/audit
  "packages/adapters/db-kysely/src/pages.ts", // integration tests: packages/adapters/db-kysely/test/pages
  "packages/adapters/db-kysely/src/admin.ts", // integration tests: packages/adapters/db-kysely/test/admin
  "packages/adapters/db-kysely/src/page-state.ts", // integration tests: packages/adapters/db-kysely/test/page-state
  "packages/adapters/db-kysely/src/trash.ts", // integration tests: packages/adapters/db-kysely/test/trash
  "packages/adapters/db-kysely/src/revisions.ts", // integration tests: packages/adapters/db-kysely/test/revisions
  "packages/adapters/db-kysely/src/attachments.ts", // integration tests: packages/adapters/db-kysely/test/attachments
  "packages/adapters/db-kysely/src/tenant-adopt.ts", // integration tests: packages/adapters/db-kysely/test/tenant-adopt
];

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      enabled: false, // switched on by `bun run test:coverage`; the plain `bun run test` stays fast
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      // Every real source file counts, tested or not: an untested file shows as 0%, it is never silently left out.
      include: ["{apps,packages}/**/src/**/*.{ts,tsx}"],
      exclude: [
        ...exclude,
        "**/*.test.ts", // tests
        "**/*.test.tsx", // tests of the web client
        "apps/web/src/main.tsx", // the entry that mounts the app into the page: no logic of its own, exercised by the browser checks
        "apps/web/src/login-main.tsx", // the entry of the sign-in document: reads the configuration and mounts the screen; the screen is tested, the entry by the browser checks
        "apps/web/src/editor/core/{mount,api,real-provider}.ts", // bind the real editor and the real provider: both need a browser (a real editor does not run in the test DOM); the end-to-end editor specs run them
        "apps/web/src/screens/page/engine.ts", // hands those two to the page screen; the screen's tests use a stand-in engine
        "**/*.d.ts", // type declarations: no code
        "**/test/**", // tests and their helpers
        "**/test-e2e/**", // end-to-end scenarios (run in containers)
        "**/fixtures/**", // sample inputs
        "packages/test-support/**", // test helpers, not shipped code
        "**/src/testing/**", // test doubles and generators shipped for tests only
        "**/src/test-facilities.ts", // test-only facilities of the config adapter
        ...integrationCovered,
        // Empty skeletons until the named task implements each one; its tests arrive with the implementation, and the task removes its line here.
      ],
      // Floors set from the measured baseline (2026-11-21, unit project only), a point or so below it. They are a ratchet:
      // `COVERAGE_RATCHET=1 bun run test:coverage` rewrites them upwards when coverage has grown; they never go down
      // except by a reviewed edit of this file. A `/* v8 ignore */` or an exclusion above needs a reason on the same line.
      thresholds: {
        autoUpdate: process.env.COVERAGE_RATCHET === "1",
        statements: 87,
        branches: 83,
        functions: 84,
        lines: 90,
        "apps/server/src/**": { statements: 67, branches: 60, functions: 71, lines: 70 },
        "packages/core/src/**": { statements: 98, branches: 96, functions: 100, lines: 100 },
        "packages/editor-schema/src/**": { statements: 95, branches: 87, functions: 96, lines: 96 },
        "packages/adapters/auth-descope/src/**": { statements: 99, branches: 98, functions: 100, lines: 100 },
        "packages/adapters/collab-hocuspocus/src/**": { statements: 93, branches: 87, functions: 91, lines: 97 },
        "packages/adapters/collab-hocuspocus/src/revisions/**": { statements: 98, branches: 95, functions: 95, lines: 100 }, // M4-T08
        "packages/adapters/collab-hocuspocus/src/extensions/revisions.ts": { statements: 100, branches: 100, functions: 100, lines: 100 }, // M4-T08
        "packages/adapters/config-env/src/**": { statements: 98, branches: 96, functions: 98, lines: 98 },
        "packages/adapters/logger-json/src/**": { statements: 99, branches: 97, functions: 96, lines: 98 },
        "packages/adapters/markdown-milkdown/src/**": { statements: 91, branches: 86, functions: 94, lines: 92 },
        // db-kysely is exercised only by the integration project (needs Postgres): its floor is in vitest.integration-coverage.config.js.
        "apps/server/src/http/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "apps/server/src/routes/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "apps/server/src/attachments/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "apps/server/src/tree/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/adapters/jobs-pgboss/src/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/tree/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/pages/**": { statements: 0, branches: 0, functions: 0, lines: 0 },
        "apps/web/src/**": { statements: 96, branches: 91, functions: 95, lines: 99 },
        "packages/core/src/attachments/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/authorize/decide.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/adapters/logger-json/src/scrub.ts": { statements: 100, branches: 98, functions: 100, lines: 100 },
        "packages/adapters/auth-descope/src/index.ts": { statements: 99, branches: 98, functions: 100, lines: 100 },
        "packages/adapters/files-s3/src/**": { statements: 99, branches: 87, functions: 100, lines: 100 },
      },
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["{apps,packages}/**/{src,test}/**/*.test.ts"],
          exclude: [...exclude, ...slow, ...benchmark, ...web],
        },
      },
      {
        test: {
          name: "web",
          environment: "happy-dom",
          include: ["apps/web/{src,test}/**/*.test.{ts,tsx}"],
          exclude: [...exclude, ...slow, ...benchmark, "apps/web/test-e2e/**"],
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
