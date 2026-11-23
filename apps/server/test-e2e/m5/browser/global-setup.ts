import { requireChromium } from './check-browser.js';

export default function globalSetup(): void {
  requireChromium();
}
