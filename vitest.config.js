import { defineConfig } from "vitest/config";

const exclude = ["**/node_modules/**", "**/dist/**", "**/coverage/**", "reference/**"];
const slow = ["**/*.int.test.ts", "**/*.container.test.ts"];
// The converter benchmark takes minutes: it has its own project and script (`bun run test:benchmark`), never `bun run test`.
const benchmark = ["**/test/benchmark/**"];

export default defineConfig({
  test: {
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
