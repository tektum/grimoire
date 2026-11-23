// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const web = path.resolve(import.meta.dirname, '../..');

describe('entry documents', () => {
  it.each(['index.html', 'login.html'])(
    '%s sets the document base to the app root before any relative URL, so a deep link such as /p/a-b1/history loads ./assets and ./config.json from the root',
    (file) => {
      const html = readFileSync(path.join(web, file), 'utf8');
      const base = html.indexOf('<base href="/" />');
      expect(base).toBeGreaterThan(-1);
      for (const tag of ['<script', '<link', '<meta name="viewport"']) {
        const at = html.indexOf(tag);
        if (at !== -1 && tag !== '<meta name="viewport"') expect(at).toBeGreaterThan(base);
      }
    },
  );
});
