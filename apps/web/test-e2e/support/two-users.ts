import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { DevRole } from '../../test/support/dev-token';
import { closeContexts } from './close-contexts';
import { type SignedInUser, signInAs } from './sign-in';

export interface Participant extends SignedInUser {
  readonly context: BrowserContext;
  readonly page: Page;
}
export interface TwoUsers {
  readonly a: Participant;
  readonly b: Participant;
  close(): Promise<void>;
}

/** Two browser contexts (own storage, own sockets), each signed in as a different development user, each with one page: for co-editing tests. */
/** The context options of the two pages: the default window, or a phone's (touch, `isMobile`, `pointer: coarse`) for the phone suite. */
export interface TwoUsersOptions {
  readonly a?: { readonly userId: string; readonly role?: DevRole };
  readonly b?: { readonly userId: string; readonly role?: DevRole };
  readonly context?: { readonly viewport: { readonly width: number; readonly height: number }; readonly hasTouch?: boolean; readonly isMobile?: boolean; readonly deviceScaleFactor?: number };
}

export async function twoUsers(browser: Browser, baseURL: string | undefined, users: TwoUsersOptions = {}): Promise<TwoUsers> {
  const a = { userId: users.a?.userId ?? 'e2e-alice', role: users.a?.role ?? 'member' };
  const b = { userId: users.b?.userId ?? 'e2e-bob', role: users.b?.role ?? 'member' };
  if (a.userId === b.userId) throw new Error('twoUsers needs two different user ids.');
  const open = async (who: { userId: string; role: DevRole }): Promise<Participant> => {
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 }, ...users.context });
    try {
      await signInAs(context, who.userId, who.role);
      return { ...who, context, page: await context.newPage() };
    } catch (error) {
      await context.close();
      throw error;
    }
  };
  const first = await open(a);
  let second: Participant;
  try {
    second = await open(b);
  } catch (error) {
    await first.context.close();
    throw error;
  }
  return { a: first, b: second, close: () => closeContexts([first.context, second.context]) };
}
