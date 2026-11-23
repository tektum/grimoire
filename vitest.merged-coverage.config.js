import base from "./vitest.config.js";
import integration from "./vitest.integration-coverage.config.js";

// Coverage of the unit and the integration project together (`bun run test:coverage:merged`): each project's run leaves a blob in
// .vitest-reports (`bun run test:coverage:ci`, `bun run test:integration:coverage:ci`), and `vitest --merge-reports` adds the coverage
// of both before the floors are checked. The floors are the unit floors of vitest.config.js plus the integration floors of
// vitest.integration-coverage.config.js, which stay in force in the integration run itself (that run alone must reach them).
export default {
  ...base,
  test: {
    ...base.test,
    coverage: {
      ...base.test.coverage,
      enabled: true,
      reportsDirectory: "coverage/merged",
      reporter: ["text", "json-summary", "lcov"],
      thresholds: { ...base.test.coverage.thresholds, ...integration.test.coverage.thresholds, autoUpdate: false },
    },
  },
};
