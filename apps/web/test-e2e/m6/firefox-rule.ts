/**
 * What the Firefox project of `apps/web/playwright.config.ts` leaves out (`FIREFOX_ARIA_CRASH_SPECS` there: Firefox, as Playwright ships it, crashes the page on the ARIA tree that axe and
 * name locators read), as a path under the repository. The exit report says of every proof that rests only on such files that Firefox does not run it; `exit.spec.ts` checks that these
 * two patterns are the config's.
 */
export const FIREFOX_LEAVES_OUT: readonly RegExp[] = [/\/test-e2e\/a11y\/(?!proof\.spec|support\.spec)/, /\/axe\.spec\.ts$/];

/** True when the Firefox project does not run the specification file (a path such as `apps/web/test-e2e/a11y/tour.spec.ts`). */
export const firefoxLeavesOut = (file: string): boolean => FIREFOX_LEAVES_OUT.some((rule) => rule.test(`/${file}`));

/** The words that a row of the report carries when Firefox does not run its proof. */
export const NOT_IN_FIREFOX = 'Firefox leaves this out';
