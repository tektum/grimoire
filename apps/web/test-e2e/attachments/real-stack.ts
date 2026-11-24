import type { Page } from '@playwright/test';

/** The address the browser reaches the file store at (the application signs links for it: `GRIMOIRE_S3_PUBLIC_ENDPOINT` of the browser job). */
export const storeOrigin = (): string => process.env['E2E_STORE_ORIGIN'] ?? 'http://127.0.0.1:8333';

/** A 1 by 1 PNG, enough for a real upload that the server accepts as an image. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/ZtqZ4wAAAABJRU5ErkJggg==';

/** Pastes this PNG into the editor under the name given, as a browser's clipboard carries a file. */
export async function pastePng(page: Page, name: string): Promise<void> {
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('Control+End');
  await page.evaluate(
    ([fileName, base64]) => {
      const bytes = Uint8Array.from(atob(base64!), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], fileName!, { type: 'image/png' }));
      document.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    [name, PNG_BASE64],
  );
}
