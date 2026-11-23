import base from "./vitest.config.js";
import integration from "./vitest.integration-coverage.config.js";

// Coverage of the unit and the integration project together (`bun run test:coverage:merged`): each project's run leaves a blob in
// .vitest-reports (`bun run test:coverage:ci`, `bun run test:integration:coverage:ci`), and `vitest --merge-reports` adds the coverage
// of both before the floors are checked. The floors are the unit floors of vitest.config.js plus the integration floors of
// vitest.integration-coverage.config.js, which stay in force in the integration run itself (that run alone must reach them).
// Where both name the same glob the higher floor of each metric holds: merged coverage is never lower than either run alone.
const unitFloors = base.test.coverage.thresholds;
const integrationFloors = integration.test.coverage.thresholds;
const thresholds = { ...unitFloors, autoUpdate: false };
for (const [glob, floor] of Object.entries(integrationFloors)) {
  const unit = unitFloors[glob];
  thresholds[glob] =
    typeof unit === "object"
      ? Object.fromEntries(Object.keys({ ...unit, ...floor }).map((metric) => [metric, Math.max(unit[metric] ?? 0, floor[metric] ?? 0)]))
      : floor;
}

export default {
  ...base,
  test: {
    ...base.test,
    coverage: {
      ...base.test.coverage,
      enabled: true,
      reportsDirectory: "coverage/merged",
      reporter: ["text", "json-summary", "lcov"],
      thresholds,
    },
  },
};
