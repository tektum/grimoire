// The migration check of the milestone 4 exit test (run by `make test-m4` against the stack `make up` started, which applied the migrations to an empty database): a
// second `grimoire migrate` applies nothing, and the runtime role cannot create a table (SQLSTATE 42501). Not a scenario: it prints `migration-check: ok` or
// `migration-check: <what failed>`, and exits 0 or 1.
import { closeDb, compose, query } from './support.ts';

async function main(): Promise<string | undefined> {
  const output = await compose('--profile', 'tools', 'run', '--rm', 'migrate');
  if (!output.includes('migrate.nothing_pending')) return `a second migrate applied something or said nothing: ${output.slice(-300)}`;
  try {
    await query('create table m4_exit_probe (id integer)');
    return 'the runtime role created a table';
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== '42501') return `creating a table was refused with ${String(code)}, expected 42501`;
  }
  return undefined;
}

const problem = await main().catch((error: unknown) => `could not run: ${error instanceof Error ? error.message : String(error)}`).finally(closeDb);
process.stdout.write(`migration-check: ${problem ?? 'ok'}\n`);
process.exit(problem === undefined ? 0 : 1);
