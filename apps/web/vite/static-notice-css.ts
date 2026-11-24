import type { Plugin } from 'vite';

/** The ES module of the notices' library, as the build reads it. */
export const SONNER_ENTRY = /[\\/]node_modules[\\/]sonner[\\/]dist[\\/]index\.mjs$/;

const INJECTOR = 'function __insertCSS(code) {';

/**
 * The library writes its stylesheet into the page as a `<style>` element when its module loads. A content security policy of `style-src 'self'` (the app's) blocks that, and
 * the notices had no styles where the policy applied. The stylesheet is a file the library publishes (`sonner/dist/styles.css`), imported by `src/ui/primitives.tsx`; this
 * takes the injection out of the library's module so the page is not told to do what its policy forbids. It refuses code that does not have the one injector it was written
 * for, so a version with a different shape stops the build instead of quietly putting the injection back.
 */
export function withoutStyleInjection(code: string): string {
  const first = code.indexOf(INJECTOR);
  if (first === -1 || code.indexOf(INJECTOR, first + 1) !== -1) throw new Error(`sonner: expected exactly one \`${INJECTOR}\` in the module; the version changed, so check how it injects its styles and update vite/static-notice-css.ts`);
  return `${code.slice(0, first + INJECTOR.length)}\n  return; // the stylesheet is shipped as a file (vite/static-notice-css.ts)${code.slice(first + INJECTOR.length)}`;
}

export function staticNoticeCss(): Plugin {
  return {
    name: 'grimoire-static-notice-css',
    enforce: 'pre',
    transform(code, id) {
      return SONNER_ENTRY.test(id) ? { code: withoutStyleInjection(code), map: null } : null;
    },
  };
}
