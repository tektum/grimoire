import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';
const ORDER: readonly Impact[] = ['minor', 'moderate', 'serious', 'critical'];

export interface AxeViolation {
  readonly id: string;
  readonly impact: Impact;
  readonly help: string;
  /** CSS selectors of the elements that break the rule. */
  readonly targets: string[];
}

/** The violations axe finds on the page as it is now (WCAG 2 A and AA rules), of `minImpact` and above. */
export async function axeViolations(page: Page, options: { minImpact?: Impact } = {}): Promise<AxeViolation[]> {
  const min = ORDER.indexOf(options.minImpact ?? 'serious');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations
    .filter((v) => v.impact != null && ORDER.indexOf(v.impact) >= min)
    .map((v) => ({ id: v.id, impact: v.impact as Impact, help: v.help, targets: v.nodes.map((n) => n.target.join(' ')) }));
}

/** A readable report: one line per violation, with the elements. */
export function formatViolations(violations: readonly AxeViolation[]): string {
  return violations.map((v) => `${v.impact} ${v.id}: ${v.help} (${v.targets.join('; ')})`).join('\n');
}

/** Fails, with the report, when the page has a violation of `minImpact` (default `serious`) or above. */
export async function expectNoAxeViolations(page: Page, options: { minImpact?: Impact } = {}): Promise<void> {
  const violations = await axeViolations(page, options);
  if (violations.length > 0) throw new Error(`${violations.length} accessibility violation(s):\n${formatViolations(violations)}`);
}
