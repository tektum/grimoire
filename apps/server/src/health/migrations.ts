import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Same location `grimoire migrate` uses by default: src/health or dist/health -> apps/server -> repo root (and /app in the image). */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

/** The newest migration this build ships, by file name without extension (names start with a sequence number). */
export function shippedMigration(dir: string = MIGRATIONS_DIR): string {
  const names = readdirSync(dir).filter((f) => /^\d+_.+\.ts$/.test(f)).map((f) => f.slice(0, -3)).sort();
  const latest = names.at(-1);
  if (latest === undefined) throw new Error('no migrations found next to the server');
  return latest;
}
