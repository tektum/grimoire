import { expect, test, type Locator } from '@playwright/test';
import { shots } from '../support/shots';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage } from './pages';

const MARKDOWN = [
  '- first bullet',
  '- second bullet',
  '  - nested bullet',
  '    - deeper bullet',
  '',
  '3. third',
  '4. fourth',
  '   1. nested step',
  '',
  'A list that starts high:',
  '',
  '998. almost a thousand',
  '999. nearly',
  '1000. a thousand',
  '',
  '- [ ] an open task',
  '- [x] a done task',
  '',
].join('\n');

const marker = (item: Locator) => item.evaluate((li) => getComputedStyle(li, '::before').content);
const style = (item: Locator, property: string, pseudo = '::before') => item.evaluate((li, [p, q]) => getComputedStyle(li, q).getPropertyValue(p as string), [property, pseudo] as const);

test.describe('lists in the page text', () => {
  test('bullets step through three shapes, numbers show as written, and task items draw a box that is filled when done', async ({ browser, baseURL }) => {
    const made = await makePage(MARKDOWN);
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      const editor = page.locator('.ProseMirror');
      await expect(editor.locator('ul').first()).toHaveCSS('list-style-type', 'none');
      const bullets = editor.locator('li[data-list-type="bullet"]:not([data-item-type])');
      expect(await marker(bullets.nth(0))).toBe('"•"');
      expect(await marker(bullets.nth(2))).toBe('"◦"');
      expect(await marker(bullets.nth(3))).toBe('"▪"');
      const numbered = editor.locator('li[data-list-type="ordered"]');
      expect(await marker(numbered.nth(0))).toBe('"3."');
      expect(await marker(numbered.nth(1))).toBe('"4."');
      // A long number runs into nothing: the text starts after the whole label.
      const long = editor.locator('li[data-label="1000."]');
      expect(await marker(long)).toBe('"1000."');
      const gap = await long.evaluate((li) => li.firstElementChild!.getBoundingClientRect().left - li.getBoundingClientRect().left);
      const labelWidth = await long.evaluate((li) => {
        const probe = document.createElement('span');
        probe.textContent = getComputedStyle(li, '::before').content.replaceAll('"', '');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-variant-numeric:tabular-nums';
        li.append(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      });
      expect(gap).toBeGreaterThanOrEqual(labelWidth);
      const tasks = editor.locator('li[data-item-type="task"]');
      expect(await marker(tasks.nth(0))).toBe('""'); // a box, not a bullet
      expect(await style(tasks.nth(0), 'border-top-style')).toBe('solid');
      expect(await style(tasks.nth(0), 'background-color')).toBe('rgba(0, 0, 0, 0)');
      expect(await style(tasks.nth(1), 'background-color')).not.toBe('rgba(0, 0, 0, 0)');
      expect(await style(tasks.nth(0), 'content', '::after')).toBe('none'); // no tick on an open task
      expect(await style(tasks.nth(1), 'content', '::after')).toBe('""'); // a tick on a done one
      await expect(tasks.nth(1).locator('> p')).toHaveCSS('text-decoration-line', 'line-through');
      await expect(tasks.nth(0).locator('> p')).toHaveCSS('text-decoration-line', 'none');
      await shots(page, 'm6-t04', 'lists');
    } finally {
      await users.close();
    }
  });
});
