import base, { integrationCovered } from "./vitest.config.js";

// Coverage of the integration project alone (`bun run test:integration:coverage`), uploaded to Codecov as the `integration` flag.
// The floors in vitest.config.js describe the unit project; this run has its own, for the one package only the integration project exercises:
// db-kysely and collab-hocuspocus (a run-to-run spread of up to 1 point was seen, so each floor sits about 1 point under the lowest reading; apps/server runs as a child process, so its integration coverage is not measured: its share is the unit floor). db-kysely measured 87.3 statements, 91.2 lines, 87.2 branches, 86.6 functions when the floor was set).
// Files that only the integration tests cover (`integrationCovered` of vitest.config.js), each with a floor a point under its first reading
// (the integration run of 2026-11-23, merged with the unit run: no unit test touches them, so the numbers are the integration run's own).
const fileFloors = {
  "packages/adapters/db-kysely/src/idempotency.ts": { statements: 99, branches: 99, functions: 99, lines: 99 },
  "packages/adapters/db-kysely/src/audit.ts": { statements: 99, branches: 99, functions: 99, lines: 99 },
  "packages/adapters/db-kysely/src/collections.ts": { statements: 96, branches: 92, functions: 99, lines: 96 },
  "packages/adapters/db-kysely/src/pages.ts": { statements: 96, branches: 91, functions: 99, lines: 99 },
  "packages/adapters/db-kysely/src/admin.ts": { statements: 96, branches: 95, functions: 99, lines: 96 },
  "packages/adapters/db-kysely/src/page-state.ts": { statements: 95, branches: 90, functions: 99, lines: 95 },
};

export default {
  ...base,
  test: {
    ...base.test,
    coverage: { ...base.test.coverage, exclude: base.test.coverage.exclude.filter((glob) => !integrationCovered.includes(glob)), enabled: true, reportsDirectory: "coverage/integration", reporter: ["text-summary", "lcov"], thresholds: { ...fileFloors, "packages/adapters/db-kysely/src/**": { statements: 86, branches: 85, functions: 85, lines: 90 }, "packages/adapters/collab-hocuspocus/src/**": { statements: 73, branches: 58, functions: 74, lines: 79 } } },
  },
};
