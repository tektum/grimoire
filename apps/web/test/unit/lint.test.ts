// @vitest-environment node
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');
const eslint = new ESLint({ cwd: root });

/** The rules the code at `file` breaks (by rule id, in source order); the file need not exist. */
async function broken(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, 'apps/web/src', file) });
  return (result?.messages ?? []).map((m) => `${m.ruleId ?? 'parse'}`);
}

const RESTRICTED = ['no-restricted-globals', 'no-restricted-syntax'];
/** Only what the restriction rules report (the fixtures are short snippets that other rules may also comment on). */
const restricted = async (code: string, file: string): Promise<string[]> => (await broken(code, file)).filter((id) => RESTRICTED.includes(id));

/** One fixture per rule: code, the folders that may use it, and a folder that may not. */
const rules: { api: string; code: string[]; allowed: string[]; refused: string[] }[] = [
  {
    api: 'localStorage',
    code: ["localStorage.setItem('k', 'v');", "window.localStorage.getItem('k');", "globalThis['localStorage'];"],
    allowed: ['storage', 'auth'],
    refused: ['ui', 'api', 'gate', 'logging', 'screens/page'],
  },
  { api: 'sessionStorage', code: ['sessionStorage.clear();', 'self.sessionStorage.clear();'], allowed: ['storage', 'auth'], refused: ['ui', 'api'] },
  { api: 'indexedDB', code: ["indexedDB.open('db');", "window.indexedDB.open('db');"], allowed: ['storage', 'auth'], refused: ['ui', 'gate'] },
  { api: 'document.cookie', code: ["document.cookie = 'a=b';", "const c = document['cookie'];", "window.document.cookie = 'a=b';", "globalThis.document['cookie'];"], allowed: ['storage', 'auth'], refused: ['ui', 'api', 'logging'] },
  {
    api: 'fetch',
    code: ["void fetch('/v1/me');", "void window.fetch('/v1/me');", "void globalThis['fetch']('/v1/me');"],
    allowed: ['api', 'auth', 'gate'],
    refused: ['ui', 'storage', 'logging', 'screens/login'],
  },
  { api: 'console', code: ["console.log('x');", "window.console.warn('x');"], allowed: ['logging'], refused: ['ui', 'api', 'auth', 'gate', 'storage'] },
];

describe('the lint rules of the web client', () => {
  for (const rule of rules) {
    it(`${rule.api}: an error outside ${rule.allowed.map((d) => `src/${d}`).join(', ')}, accepted inside`, async () => {
      for (const code of rule.code) {
        for (const dir of rule.refused) expect([rule.api, code, dir, (await restricted(code, `${dir}/x.ts`)).length > 0]).toEqual([rule.api, code, dir, true]);
        for (const dir of rule.allowed) expect([rule.api, code, dir, await restricted(code, `${dir}/x.ts`)]).toEqual([rule.api, code, dir, []]);
      }
    });
  }

  it('applies to the files directly under src and to .tsx files too', async () => {
    expect((await broken("console.log('x');", 'main.tsx')).some((id) => RESTRICTED.includes(id))).toBe(true);
    expect((await broken('localStorage.clear();', 'app/shell.tsx')).some((id) => RESTRICTED.includes(id))).toBe(true);
  });

  it('lets each allowed folder use only its own APIs', async () => {
    expect(await restricted("fetch('/x'); console.log('x');", 'api/x.ts')).toHaveLength(1); // fetch is fine, console is not
    expect(await restricted("localStorage.clear(); fetch('/x');", 'storage/x.ts')).toHaveLength(1);
    expect(await restricted("localStorage.clear(); fetch('/x'); console.log('x');", 'auth/x.ts')).toHaveLength(1);
  });

  it('accepts code that touches none of them, and a local name that only looks like one', async () => {
    expect(await broken('export const add = (a: number, b: number) => a + b;', 'ui/x.ts')).toEqual([]);
    expect(await broken('const fetch = (n: number) => n; export const x = fetch(1);', 'ui/x.ts')).toEqual([]);
  });

  it('refuses an import of an adapter or the server from the client, anywhere in it', async () => {
    for (const source of ['@tektum/grimoire-adapter-db-kysely', '@tektum/grimoire-adapter-files-s3', '@tektum/grimoire-server']) {
      expect([source, (await broken(`import x from '${source}'; export default x;`, 'ui/x.ts')).includes('no-restricted-imports')]).toEqual([source, true]);
    }
    expect(await broken("import { compareVersions } from '@tektum/grimoire-core/version'; export default compareVersions;", 'ui/x.ts')).toEqual([]);
  });

  it('still refuses a computed import path in the client', async () => {
    expect((await broken("const p = 'x'; export const m = import(p);", 'ui/x.ts')).includes('no-restricted-syntax')).toBe(true);
  });
});
