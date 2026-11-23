import base, { integrationCovered } from "./vitest.config.js";

// Coverage of the integration project alone (`bun run test:integration:coverage`), uploaded to Codecov as the `integration` flag.
// The floors in vitest.config.js describe the unit project; this run has its own, for the one package only the integration project exercises:
// db-kysely and collab-hocuspocus (a run-to-run spread of up to 1 point was seen, so each floor sits about 1 point under the lowest reading; apps/server runs as a child process, so its integration coverage is not measured: its share is the unit floor). db-kysely measured 87.3 statements, 91.2 lines, 87.2 branches, 86.6 functions when the floor was set).
export default {
  ...base,
  test: {
    ...base.test,
    coverage: { ...base.test.coverage, exclude: base.test.coverage.exclude.filter((glob) => !integrationCovered.includes(glob)), enabled: true, reportsDirectory: "coverage/integration", reporter: ["text-summary", "lcov"], thresholds: { "packages/adapters/db-kysely/src/**": { statements: 86, branches: 85, functions: 85, lines: 90 }, "packages/adapters/collab-hocuspocus/src/**": { statements: 73, branches: 58, functions: 74, lines: 79 } } },
  },
};
