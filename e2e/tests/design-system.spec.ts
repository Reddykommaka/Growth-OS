/**
 * The checks that jsdom cannot make truthfully.
 *
 * Component tests (packages/ui) disable axe's colour-contrast and page-scope rules because
 * jsdom cannot resolve a computed colour from custom properties in an external stylesheet,
 * and a primitive in isolation has no landmark. Both are real WCAG 2.2 AA requirements
 * (13-design-system.md §5) — this suite is where they are actually verified.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const FIXTURE = pathToFileURL(resolve(import.meta.dirname, '../fixtures/primitives.html')).href;

const THEMES = ['light', 'dark'] as const;

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(FIXTURE);
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      // Custom properties resolve on the next paint.
      await page.waitForFunction(
        (t) => document.documentElement.getAttribute('data-theme') === t,
        theme,
      );
    });

    test('meets WCAG 2.2 AA, including colour contrast', async ({ page }) => {
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();

      expect(
        results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => n.target.join(' ')),
        })),
      ).toEqual([]);
    });

    test('every text role has sufficient contrast on its surface', async ({ page }) => {
      // Explicitly asserted rather than relying on axe alone: axe skips elements it judges
      // to have an indeterminate background, which is exactly where a token mistake hides.
      const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();

      const incomplete = results.incomplete.flatMap((r) => r.nodes.map((n) => n.target.join(' ')));
      expect(
        { violations: results.violations.length, indeterminate: incomplete },
        'axe could not determine contrast for these nodes; a token mistake would hide here',
      ).toEqual({ violations: 0, indeterminate: [] });
    });

    test('paints a visible focus ring on keyboard focus', async ({ page }) => {
      // The tokens set `outline: none` and replace it with a box-shadow ring. If the
      // replacement ever fails, a keyboard user has no affordance at all — and no unit
      // test can see it, because it is a computed style.
      const button = page.getByTestId('btn-primary');
      const before = await button.evaluate((el) => getComputedStyle(el).boxShadow);

      await page.keyboard.press('Tab');
      await expect(button).toBeFocused();

      const after = await button.evaluate((el) => getComputedStyle(el).boxShadow);
      expect(after, 'focus produced no visible box-shadow ring').not.toBe(before);
      expect(after).not.toBe('none');
    });

    test('disabled controls remain distinguishable', async ({ page }) => {
      const disabled = page.getByRole('button', { name: 'Disabled' });
      const opacity = await disabled.evaluate((el) => Number(getComputedStyle(el).opacity));
      // Low enough to read as unavailable, high enough to still be legible.
      expect(opacity).toBeGreaterThanOrEqual(0.4);
      expect(opacity).toBeLessThan(1);
    });
  });
}

test('renders tabular numerals so figures align in dense tables', async ({ page }) => {
  await page.goto(FIXTURE);
  const variant = await page.evaluate(
    () => getComputedStyle(document.documentElement).fontVariantNumeric,
  );
  expect(variant).toContain('tabular-nums');
});

test('honours prefers-reduced-motion', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(FIXTURE);

  const duration = await page
    .getByTestId('btn-primary')
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  // The reduced-motion block collapses every transition to 0.01ms. Chromium serialises
  // that as "1e-05s", so parse rather than pattern-match a formatting choice.
  const seconds = Number.parseFloat(duration);
  expect(Number.isNaN(seconds)).toBe(false);
  expect(seconds).toBeLessThan(0.001);
  await context.close();
});
