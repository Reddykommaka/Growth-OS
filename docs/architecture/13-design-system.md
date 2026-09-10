# 13 — Design System

## 1. The problem to avoid

The directive is specific about what this must not look like, and the failure mode has a
recognisable signature: a purple-to-blue gradient headline, four evenly-weighted stat cards
with 16px radii and emoji icons, a soft shadow on everything, and generous whitespace that
makes a data-dense product feel empty. That look comes from adopting a component library's
defaults wholesale.

Growth OS is an **operating system for a business**. Operators live in it for hours. It
should read like a professional instrument — Bloomberg Terminal, Linear, Stripe Dashboard —
where density, hierarchy and keyboard speed matter more than decoration.

## 2. Foundations

**Tokens, not values.** Three tiers, expressed as CSS custom properties so themes swap by
redefining variables rather than shipping alternative stylesheets:

```
primitive   --gray-950 … --gray-50, --accent-600, --space-1 … --space-16
semantic    --surface-base, --surface-raised, --surface-sunken,
            --text-primary, --text-secondary, --text-tertiary,
            --border-subtle, --border-strong, --accent, --status-{positive,negative,warning,info}
component   --table-row-height, --sidebar-width, --field-height
```

Product code uses **semantic** tokens only. A raw hex value or an arbitrary Tailwind value
(`text-[#4f46e5]`) fails lint. This is what keeps a hundred screens visually coherent.

### Typography

- **UI:** Inter (or a comparable neutral grotesque), 13px base — deliberately below the
  16px web default, because this is an application, not a document.
- **Numerals:** tabular figures everywhere numbers align. Non-tabular figures in a metrics
  column is the single most common tell of an unconsidered dashboard.
- **Code / ids:** JetBrains Mono.
- **Scale:** 11 / 12 / 13 / 15 / 18 / 24 / 32. Small, purposeful, and few. Weight (450 / 550 /
  650) carries hierarchy more than size does.
- **Measure:** 65–75 characters for prose.

### Colour

- A near-neutral greyscale carries ~90% of the interface.
- **One** accent, used for interactive affordance and the primary action only — never for
  decoration. If everything is accented, nothing is.
- Status colours are reserved for status. A positive number is not green unless "up" is
  actually good in that context (cost per lead rising is not good — the chart must know the
  metric's polarity, and the metric registry carries it).
- Data-visualisation palettes are separate, colour-blind safe, and tested at both themes.
- Contrast: WCAG 2.2 AA minimum; AAA for body text where achievable.

### Space and shape

- 4px base grid. Every dimension is a multiple.
- **Radii are small and few**: 4px controls, 6px containers, full for pills only. The
  "everything is a 16px rounded card" look is explicitly out.
- **Elevation is borders first, shadow rarely.** One subtle shadow token for genuinely
  floating surfaces (menus, dialogs, toasts). Nothing on a static panel.
- No glassmorphism. No gradient text. No decorative illustration or generic AI imagery.
- Emoji never appear as UI iconography; icons come from one line-icon set at a consistent
  stroke weight.

### Motion

- 120ms for state changes, 180ms for surfaces, `ease-out`. Motion signals cause and effect;
  it never entertains.
- `prefers-reduced-motion` removes transforms and keeps opacity fades only.

## 3. Density and layout

Three density modes (`comfortable` / `default` / `compact`) driven by component tokens and
persisted per user. A social calendar and a CRM table have genuinely different density
needs, and forcing one is worse than supporting three.

Layout primitives:
- **App shell:** persistent left navigation (collapsible, keyboard-reachable), a workspace
  switcher that makes the current tenant unmistakable, a global command palette (`⌘K`).
- **Page pattern:** header (title, context, primary action) → filter bar → content → detail
  panel. Every list screen in the product uses this same skeleton, so learning one screen
  teaches all of them.
- **Detail panels slide over**, they do not navigate away — reviewing 40 comments should not
  cost 40 page loads.
- **Tables are the primary surface**, not cards: virtualized, resizable and reorderable
  columns, sticky header, multi-select with bulk actions, saved views, keyboard row
  navigation, inline edit where it is safe.

## 4. Data visualisation

Charts are built from `visx` primitives on our own tokens — a charting library's default
theme is exactly the generic look we are avoiding.

Rules:
- Every chart states its **grain, timezone and freshness**. A number without a defined
  window is not a fact.
- Axes start at zero for magnitude comparisons; truncation is labelled explicitly.
- Direct labelling over legends wherever it fits.
- Sparklines and inline deltas in tables carry more decision value per pixel than a
  full-width hero chart, and are preferred.
- Every chart has an accessible tabular equivalent, reachable by keyboard.
- Loading is skeletal and layout-stable; empty states explain *why* it is empty and offer
  the next action; error states offer retry and a support reference.
- No chart junk: no 3D, no gradient fills, no drop shadows on data marks.

## 5. Accessibility (a requirement, not a pass at the end)

- Target **WCAG 2.2 AA**, verified in CI with `axe` at component and E2E level.
- Behaviour comes from Radix primitives — focus traps, roving tabindex, ARIA — because
  hand-rolled dialogs and menus are where accessibility silently breaks.
- **Fully keyboard operable**: every action reachable without a pointer; visible focus
  rings that are never removed; logical tab order; skip links.
- Screen-reader semantics: real landmarks, live regions for async results, accessible names
  on every control.
- Respects `prefers-reduced-motion`, `prefers-color-scheme` and OS text sizing up to 200%
  without loss of function.
- Dark and light themes are **both first-class**, tested equally. Operators work at night.

## 6. Component architecture

```
packages/ui/
├── tokens/         CSS variables, theme definitions, the Tailwind preset
├── primitives/     Button, Input, Select, Checkbox, Dialog, Popover, Tooltip, Menu, Tabs…
├── patterns/       DataTable, FilterBar, PageHeader, DetailPanel, EmptyState, CommandPalette,
│                   FormField, ConfirmDialog, StatusBadge, MetricTile
├── charts/         (packages/charts) Line, Bar, Area, Funnel, Cohort, Sparkline, Distribution
└── icons/          One curated line set
```

Rules:
- **Primitives are presentational.** They receive data and callbacks; they do not fetch,
  and they never contain business rules.
- **Composition over configuration.** A component with fifteen boolean props should have
  been three components.
- Every component ships with: TypeScript props, a Storybook entry covering states
  (default / hover / focus / disabled / loading / error / empty), an `axe` assertion, a
  keyboard test, and both themes.
- No component may import from `packages/modules/*` — enforced by dependency-cruiser.

## 7. Voice

Interface copy is precise, short and non-cute. It names what happened and what to do next.
No exclamation marks, no "Oops!", no anthropomorphising. Errors say what failed, why, and
the next action, and carry a reference id that appears in our logs — because the fastest
support interaction is one where the customer can quote a traceable id.
