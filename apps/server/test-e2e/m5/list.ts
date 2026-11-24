import { readdirSync } from 'node:fs';

/** The scenarios of the run, in order. `make test-m5` runs exactly these; a file that is not listed, or a name without a file, stops the run. */
export const SCENARIOS = ['attachment-flow', 'store-enforcement', 'hostile-files', 'scoped-key', 'purge-removes-object', 'pending-cap', 'cleanup', 'idempotent-create'] as const;

/** What is wrong between the list and the directory of scenario files: empty when they are the same set. */
export function listProblems(dir: string, listed: readonly string[] = SCENARIOS): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3));
  return [
    ...files.filter((f) => !listed.includes(f)).map((f) => `${f} is a scenario file that is not in the run list`),
    ...listed.filter((n) => !files.includes(n)).map((n) => `${n} is in the run list and has no file`),
  ];
}
