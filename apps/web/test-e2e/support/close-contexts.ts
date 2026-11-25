import type { BrowserContext } from '@playwright/test';

/** What the browser says when the context it is asked to close is not there any more: the goal of a close, reached by something else (the context was closed already, or the browser went). */
const GONE = /Target page, context or browser has been closed|Failed to find context|Browser has been closed|Context has been closed|browserContext\.close: Target closed/;

/**
 * Closes the contexts one after the other (two disposals at once in one browser are what the failing runs had in common), every one of them even if an earlier one fails, and treats a context that is
 * already gone as closed. Any other failure is thrown, the first one, after all have been tried.
 */
export async function closeContexts(contexts: readonly Pick<BrowserContext, 'close'>[]): Promise<void> {
  let failure: { readonly error: unknown } | undefined;
  for (const context of contexts) {
    try {
      await context.close();
    } catch (error) {
      if (!GONE.test(error instanceof Error ? error.message : String(error))) failure ??= { error };
    }
  }
  if (failure !== undefined) throw failure.error;
}
