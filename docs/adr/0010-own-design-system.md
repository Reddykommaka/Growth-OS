# ADR-0010 — Own design system built on unstyled accessible primitives

**Status:** Accepted · **Date:** 2026-09-10 · **Approved:** 2026-09-10

## Context
The product must not look like generic AI-generated SaaS, must support dense enterprise
interfaces, and must be accessible. Accessible interaction behaviour (focus traps, roving
tabindex, ARIA relationships) is genuinely hard and routinely got wrong when hand-rolled.

## Decision
Build our own design system: tokens → primitives → patterns, with **Radix UI** supplying
unstyled behaviour and **Tailwind v4** binding CSS-variable tokens. We author 100% of the
visual layer. Charts are composed from `visx` primitives on the same tokens.

## Alternatives considered
- **shadcn/ui as a scaffold.** Its copy-in ownership model is right, and we adopt that
  pattern; its default styling is rejected because it is the most recognisable "AI-generated
  SaaS" appearance in existence.
- **MUI / Ant Design / Chakra.** Rejected: each imposes a strong visual language that is
  expensive to override and fights density.
- **Fully hand-rolled including behaviour.** Rejected: accessibility regressions are
  near-certain and hard to detect.

## Consequences
**Positive:** a distinctive, dense, coherent product; accessibility inherited from primitives
and verified in CI; theming by variable swap.

**Negative:** significant component work before feature velocity improves; we own visual
consistency. Mitigated by building the system in Phase 0–1 and enforcing token-only usage
with lint.
