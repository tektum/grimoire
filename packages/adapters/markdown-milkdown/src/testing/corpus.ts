import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The committed stability corpus: one Markdown file per construct group, in `test/stability/cases`. */
const CASES_DIR = fileURLToPath(new URL('../../test/stability/cases/', import.meta.url));
export const GOLDEN_DIR = fileURLToPath(new URL('../../test/golden/expected/', import.meta.url));

export interface CorpusCase {
  name: string;
  markdown: string;
}

export function loadCorpus(): CorpusCase[] {
  return readdirSync(CASES_DIR)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => ({ name: file.replace(/\.md$/, ''), markdown: readFileSync(`${CASES_DIR}${file}`, 'utf8') }));
}
