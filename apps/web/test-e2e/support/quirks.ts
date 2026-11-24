import type { BrowserContext, Page } from '@playwright/test';

// What the three engines do differently where a specification asks them the same thing.

/**
 * The name a download of `name` has in this engine: WebKit turns spaces into underscores in the name it suggests (`Reset plan-your-copy.md` is `Reset_plan-your-copy.md`),
 * Chromium and Firefox keep it.
 */
export const downloadName = (browserName: string, name: string): string => (browserName === 'webkit' ? name.replace(/ /g, '_') : name);

/**
 * Lets the pages of `context` copy to the clipboard and read back what was copied. Chromium has a clipboard permission to grant and a real clipboard to read; Firefox and WebKit have
 * neither in a headless run, so there the page's `navigator.clipboard.writeText` is wrapped to keep what it was asked to copy, and `copied()` returns that: the specification still
 * checks what the page copies, not the engine's clipboard.
 */
export async function watchClipboard(context: BrowserContext, browserName: string, origin: string): Promise<(page: Page) => Promise<string>> {
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    return (page) => page.evaluate(() => navigator.clipboard.readText());
  }
  await context.addInitScript(() => {
    const written: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = written;
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text: string) => {
      written.push(text);
      return write(text).catch(() => undefined); // an engine that refuses the write in a headless run: the page still believes it copied
    };
  });
  return (page) => page.evaluate(() => ((window as unknown as { __copied?: string[] }).__copied ?? []).join('\n'));
}

/**
 * Firefox, as Playwright 1.65 ships it, crashes the page ("Page crashed") when the accessibility tree of a page that has an `aria-labelledby` region is read from two scripting worlds:
 * by axe and by a locator that goes by a label or a name, on every screen of the client (each is a section named by its title). Playwright issue 44135; fixed in Firefox 163
 * (Mozilla bug 2090055), which Playwright has not shipped. The specifications that meet it are marked with this reason for Firefox: they run in Chromium and WebKit, and the run
 * of Firefox lists them as fixme, not as passed. Take the mark off with the Playwright that ships the fix.
 */
export const FIREFOX_ARIA_CRASH =
  'Firefox crashes the page when its ARIA tree is read from two scripting worlds (Playwright issue 44135, Mozilla bug 2090055, fixed in Firefox 163): runs in Chromium and WebKit until Playwright ships that Firefox';
