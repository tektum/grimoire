// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SONNER_ENTRY, staticNoticeCss, withoutStyleInjection } from '../../vite/static-notice-css';

// The notices' library writes its stylesheet into the page as a <style> element when it loads, which a policy of `style-src 'self'` blocks (the notices were unstyled where the
// policy applies). The stylesheet is shipped as a file instead (`sonner/dist/styles.css`, imported by the notices' module), and the build takes the library's own injection
// out. These tests keep that true for the version that is installed, and fail loudly for a version whose code looks different.
// The tests run from the repository root, where the package manager puts the library.
const library = (file: string): string => readFileSync(resolve(process.cwd(), 'node_modules/sonner/dist', file), 'utf8');
const entry = library('index.mjs');
// The injecting function is the head of the module: everything before the first import.
const head = (code: string): string => code.slice(0, code.indexOf('import '));

/** How many <style> elements the head of the module would put into a page when its function is called with some CSS. */
function injected(code: string): number {
  const created: string[] = [];
  const document = { head: { appendChild: () => undefined }, createElement: (tag: string) => { created.push(tag); return { appendChild: () => undefined, styleSheet: undefined }; }, createTextNode: () => ({}), getElementsByTagName: () => [{ appendChild: () => undefined }] };
  vm.runInNewContext(`${head(code).replace("'use client';", '')}\n__insertCSS('a{b:c}');`, { document });
  return created.filter((tag) => tag === 'style').length;
}

describe('the notices\' stylesheet', () => {
  it('is injected by the library as it comes (the control: this is what the policy blocks)', () => {
    expect(injected(entry)).toBe(1);
  });

  it('is not injected once the build has taken the injection out, and the rest of the module is as it was', () => {
    const changed = withoutStyleInjection(entry);
    expect(injected(changed)).toBe(0);
    expect(changed.slice(head(changed).length)).toBe(entry.slice(head(entry).length));
  });

  it('refuses a module that does not look the way it was written for, rather than leave the injection in', () => {
    expect(() => withoutStyleInjection('export const x = 1;')).toThrow(/sonner/i);
    expect(() => withoutStyleInjection(`${entry}\n${head(entry)}`)).toThrow(/sonner/i); // two of them: not what was checked
  });

  it('is shipped as a file the library publishes, with the rules of the notices in it', () => {
    const css = library('styles.css');
    expect(css).toContain('[data-sonner-toaster]');
    expect(css).toContain('[data-sonner-toast]');
  });

  it('applies to the library\'s own module and to nothing else', () => {
    const plugin = staticNoticeCss();
    const transform = plugin.transform as (code: string, id: string) => { code: string } | null;
    expect(SONNER_ENTRY.test('/x/node_modules/sonner/dist/index.mjs')).toBe(true);
    expect(SONNER_ENTRY.test('/x/node_modules/sonner/dist/index.js')).toBe(false); // the build reads the ES module
    expect(SONNER_ENTRY.test('/x/src/ui/sonner/dist/index.mjs')).toBe(false);
    expect(transform.call({}, entry, '/x/src/app/main.tsx')).toBeNull();
    expect(transform.call({}, entry, '/x/node_modules/sonner/dist/index.mjs')?.code).toBe(withoutStyleInjection(entry));
  });

  it('is imported by the notices\' module, so the stylesheet is in the build', () => {
    expect(readFileSync(resolve(process.cwd(), 'apps/web/src/ui/primitives.tsx'), 'utf8')).toContain("import 'sonner/dist/styles.css';");
  });
});
