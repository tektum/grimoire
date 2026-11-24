import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../server/support/harness.js';

const text = readFileSync(path.join(repoRoot, 'docs/files.md'), 'utf8');
const limits = text.slice(text.indexOf('## Limits'));

// The limits of the first version are written down, each as a sentence a reader can find: this fails when one is removed or reworded away.
const statements: [string, RegExp][] = [
  ['no malware scan', /no malware or virus scan of uploads/i],
  ['images keep hidden data', /Images keep any hidden data they were uploaded with/],
  ['no storage quota', /no storage quota/i],
  ['a PDF is downloaded', /A PDF is always downloaded, never shown in the page/],
  ['unfinished uploads are cleaned up by a job that is not scheduled yet', /never completed are removed by a clean-up that is not scheduled yet/],
  ['300-second window after access is lost', /keeps working for up to 300 seconds after the reader loses access/],
];

describe('docs/files.md', () => {
  it.each(statements)('states the limit: %s', (_name, pattern) => {
    expect(limits).toMatch(pattern);
  });

  it('numbers exactly six limits', () => {
    expect([...limits.matchAll(/^\d+\. \*\*/gm)]).toHaveLength(6);
  });

  it('says that a purge that fails half-way marks `deleted_at`, and where the content security policy origin comes from', () => {
    expect(text).toMatch(/marked deleted \(`deleted_at`\)/);
    expect(text).toMatch(/content security policy comes from the headers of the web server/);
  });

  it('names the numbers the routes use: 300 seconds for a link, 10 minutes for an upload address, an hour for a waiting upload', () => {
    for (const phrase of ['300 seconds', '10 minutes', 'within an hour']) expect(text).toContain(phrase);
  });
});
