/**
 * Component-test helper.
 *
 * 18-phase-0-plan.md work item 0.6: "axe assertion and keyboard-navigation test REQUIRED by
 * the component test helper, so a component without them cannot pass review."
 *
 * `describeComponent` is the only sanctioned way to write a primitive's test suite. It adds
 * the accessibility and keyboard assertions itself, in BOTH themes, so they cannot be
 * omitted by forgetting rather than by decision.
 */
import { type RenderResult, render } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe, { type AxeResults, type Result } from 'axe-core';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

export type Theme = 'light' | 'dark';

/** Renders under an explicit theme so both palettes are exercised. */
export function renderThemed(ui: ReactElement, theme: Theme = 'light'): RenderResult {
  document.documentElement.setAttribute('data-theme', theme);
  return render(ui);
}

export interface AxeViolation {
  readonly id: string;
  readonly impact: string;
  readonly nodes: number;
  readonly help: string;
}

/**
 * Rules that describe a PAGE, not a component.
 *
 * A primitive rendered in isolation has no landmark, no <h1>, no <title> and no skip link,
 * so these fire on every component and would train everyone to ignore the output. They are
 * genuine requirements — verified against a real page in the Playwright suite
 * (11-testing-architecture.md §6), which is the only place they can be assessed truthfully.
 */
const PAGE_SCOPE_RULES = [
  'region', // all content should be inside a landmark
  'landmark-one-main',
  'page-has-heading-one',
  'html-has-lang',
  'document-title',
  'bypass', // skip link
] as const;

/**
 * Runs axe over the rendered markup.
 *
 * Colour-contrast is excluded in jsdom: it cannot resolve a computed colour from CSS custom
 * properties in an external stylesheet, so the rule reports nothing rather than something
 * true. Contrast is verified in a real browser, and reporting a jsdom pass would be a false
 * assurance — worse than no check, because it would be believed.
 */
export async function findAccessibilityViolations(container: HTMLElement): Promise<AxeViolation[]> {
  const disabled = Object.fromEntries(
    ['color-contrast', ...PAGE_SCOPE_RULES].map((id) => [id, { enabled: false }]),
  );
  const results: AxeResults = await axe.run(container, {
    rules: disabled,
    resultTypes: ['violations'],
  });
  return results.violations.map((v: Result) => ({
    id: v.id,
    impact: v.impact ?? 'unknown',
    nodes: v.nodes.length,
    help: v.help,
  }));
}

export interface ComponentSpec {
  /** Rendered for the automatic accessibility and keyboard assertions. */
  readonly render: () => ReactElement;
  /**
   * Set false ONLY for a component that is genuinely not focusable (a static badge).
   * Every interactive component must be keyboard reachable; a component with no keyboard
   * path does not merit review (13-design-system.md §5).
   */
  readonly interactive?: boolean;
  /** Additional states to check — disabled, loading, error, empty. */
  readonly states?: Readonly<Record<string, () => ReactElement>>;
}

/**
 * Declares a component suite. Callers add their own behaviour tests inside `extra`; the
 * accessibility and keyboard tests are contributed here and cannot be skipped.
 */
export function describeComponent(name: string, spec: ComponentSpec, extra?: () => void): void {
  describe(name, () => {
    afterEach(() => {
      document.documentElement.removeAttribute('data-theme');
    });

    describe('accessibility (contributed by describeComponent)', () => {
      for (const theme of ['light', 'dark'] as const) {
        it(`has no axe violations in the ${theme} theme`, async () => {
          renderThemed(spec.render(), theme);
          // document.body, not the render container: Dialog, Menu, Select, Popover and
          // Tooltip render through a portal, so their markup is never inside it.
          const violations = await findAccessibilityViolations(document.body);
          expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
        });
      }

      for (const [stateName, renderState] of Object.entries(spec.states ?? {})) {
        it(`has no axe violations in the "${stateName}" state`, async () => {
          renderThemed(renderState(), 'light');
          const violations = await findAccessibilityViolations(document.body);
          expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
        });
      }
    });

    if (spec.interactive !== false) {
      describe('keyboard (contributed by describeComponent)', () => {
        it('is reachable by pressing Tab', async () => {
          // Behavioural, not structural. An earlier version looked for a focusable
          // button/input, which reported Tabs as unreachable: Radix's roving-focus group
          // puts tabindex="0" on the TABLIST wrapper and -1 on every tab button, so the
          // entry point is not a control at all. Pressing Tab is the only check that is
          // true for every correct pattern.
          const user = userEvent.setup();
          renderThemed(spec.render());
          await user.tab();

          // "Focus rests on something", not "focus moved": a Dialog already places focus
          // inside itself on open, and with a single focusable element the trap keeps it
          // there, so a moved-focus assertion would fail on a correctly behaving modal.
          const active = document.activeElement;
          expect(
            active !== null && active !== document.body,
            'Keyboard focus never reached the component. An interactive component must be ' +
              'reachable without a pointer; set interactive: false only for a genuinely ' +
              'static one (13-design-system.md §5).',
          ).toBe(true);
        });
      });
    }

    extra?.();
  });
}
