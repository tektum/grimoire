import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { repoRoot } from './env';

/** The width of a screenshot: 1280, or `E2E_SHOTS_WIDTH` (the redesign takes its pictures at 1440 and at 390). */
const shotsWidth = (): number => Number(process.env['E2E_SHOTS_WIDTH'] ?? 1280);

export const THEMES = ['light', 'dark'] as const;

/** Where the screenshots of `task` go: `test-results/shots/<task>/` (the CI job uploads the folder). */
export const shotsDir = (task: string): string => path.join(process.env['E2E_SHOTS_DIR'] ?? path.join(repoRoot, 'test-results/shots'), task);

/** The file of one screenshot: `<name>-<light|dark>.png`. Names are plain words, so a name cannot leave the folder. */
export function shotPath(task: string, name: string, theme: (typeof THEMES)[number]): string {
  if (!/^[A-Za-z0-9._-]+$/.test(task) || !/^[A-Za-z0-9._-]+$/.test(name) || task.startsWith('.') || name.startsWith('.')) throw new Error('A screenshot task and name are letters, digits, . _ and - only.');
  return path.join(shotsDir(task), `${name}-${theme}.png`);
}

/**
 * Takes the page twice, light and dark, at 1280 by 800 (`width` for a wider or narrower view, such as the outline), and writes
 * `<name>-light.png` and `<name>-dark.png`. Inputs of type password are masked, so a secret never appears in a picture.
 */
export async function shots(page: Page, task: string, name: string, options: { width?: number } = {}): Promise<string[]> {
  const written: string[] = [];
  const previous = page.viewportSize();
  await page.setViewportSize({ width: options.width ?? shotsWidth(), height: 800 });
  try {
    for (const theme of THEMES) {
      const file = shotPath(task, name, theme);
      mkdirSync(path.dirname(file), { recursive: true });
      await page.emulateMedia({ colorScheme: theme });
      await page.screenshot({ path: file, animations: 'disabled', scale: 'css', mask: [page.locator('input[type="password"]')], maskColor: '#808080' }); // scale css: 1280 by 800 pixels in every engine (WebKit's device draws at twice)
      written.push(file);
    }
  } finally {
    await page.emulateMedia({ colorScheme: null });
    if (previous !== null) await page.setViewportSize(previous);
  }
  return written;
}
