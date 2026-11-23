import { requireChromium } from './check-browser.ts';

// The check on its own, for the test that forces a wrong path: exit 0 when the browser is there, 1 and the line when not.
requireChromium();
