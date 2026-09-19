/**
 * Resolution, as a pure function.
 *
 * Precedence is the whole of this file. An entitlement system that resolves ambiguously is
 * one where "why can this customer not do that" has no answer — so every case here asserts
 * both the OUTCOME and the SOURCE that produced it.
 */
import { describe, expect, it } from 'vitest';
import { capability } from './catalogue.js';
import { checkAllowance, type ExpiringGrant, resolveEntitlement } from './resolve.js';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const scheduling = capability('social.scheduling');
const analytics = capability('social.analytics');
if (scheduling === undefined || analytics === undefined) throw new Error('catalogue');

const grant = (over: Partial<ExpiringGrant> = {}): ExpiringGrant => ({
  enabled: true,
  isUnlimited: false,
  reason: 'test',
  ...over,
});

describe('precedence', () => {
  it('falls back to the catalogue default, and SAYS it did', () => {
    const d = resolveEntitlement({ capability: scheduling, now: NOW });
    expect(d.source).toBe('default');
    expect(d.enabled).toBe(true);
    expect(d.limit).toEqual({ kind: 'bounded', value: 30 });
    expect(d.rule).toContain('catalogue default');
  });

  it('a plan feature beats the default', () => {
    const d = resolveEntitlement({
      capability: scheduling,
      planFeature: { enabled: true, limitValue: 500, isUnlimited: false },
      now: NOW,
    });
    expect(d.source).toBe('plan');
    expect(d.limit).toEqual({ kind: 'bounded', value: 500 });
  });

  it('an organization override beats the plan', () => {
    const d = resolveEntitlement({
      capability: scheduling,
      planFeature: { enabled: true, limitValue: 500, isUnlimited: false },
      organizationOverride: grant({ isUnlimited: true }),
      now: NOW,
    });
    expect(d.source).toBe('organization_override');
    expect(d.limit).toEqual({ kind: 'unlimited' });
  });

  it('a workspace override beats an organization override', () => {
    const d = resolveEntitlement({
      capability: scheduling,
      organizationOverride: grant({ limitValue: 100 }),
      workspaceOverride: grant({ limitValue: 5 }),
      now: NOW,
    });
    expect(d.source).toBe('workspace_override');
    expect(d.limit).toEqual({ kind: 'bounded', value: 5 });
  });

  /**
   * The direction that matters. Revoking a capability for one customer — abuse,
   * non-payment, a legal hold — must not require moving them off their plan.
   */
  it('a DISABLING override beats an enabling plan feature', () => {
    const d = resolveEntitlement({
      capability: analytics,
      planFeature: { enabled: true, isUnlimited: true },
      organizationOverride: grant({ enabled: false }),
      now: NOW,
    });
    expect(d.enabled).toBe(false);
    expect(d.source).toBe('organization_override');
  });

  it('an EXPIRED override is not an override', () => {
    const d = resolveEntitlement({
      capability: scheduling,
      planFeature: { enabled: true, limitValue: 500, isUnlimited: false },
      organizationOverride: grant({
        isUnlimited: true,
        expiresAt: new Date('2026-09-18T00:00:00.000Z'),
      }),
      now: NOW,
    });
    expect(d.source).toBe('plan');
    expect(d.limit).toEqual({ kind: 'bounded', value: 500 });
  });

  it('an override expiring in the future still applies', () => {
    const d = resolveEntitlement({
      capability: scheduling,
      organizationOverride: grant({
        isUnlimited: true,
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
      }),
      now: NOW,
    });
    expect(d.source).toBe('organization_override');
  });
});

describe('limits', () => {
  it('a zero limit is NOT entitlement — it is a capability granted nothing', () => {
    const d = resolveEntitlement({
      capability: scheduling,
      planFeature: { enabled: true, limitValue: 0, isUnlimited: false },
      now: NOW,
    });
    expect(d.limit).toEqual({ kind: 'none' });
    expect(d.enabled).toBe(false);
  });

  it('reports what is left', () => {
    const d = resolveEntitlement({
      capability: scheduling,
      planFeature: { enabled: true, limitValue: 10, isUnlimited: false },
      used: 4,
      now: NOW,
    });
    expect(d.remaining).toBe(6);
  });

  it('never reports negative headroom, even when usage exceeds a lowered limit', () => {
    // The realistic case: a downgrade lowers the limit below what is already consumed.
    const d = resolveEntitlement({
      capability: scheduling,
      planFeature: { enabled: true, limitValue: 5, isUnlimited: false },
      used: 40,
      now: NOW,
    });
    expect(d.remaining).toBe(0);
    expect(checkAllowance(d).allowed).toBe(false);
  });

  it('an unlimited grant reports no remaining, rather than a large number', () => {
    const d = resolveEntitlement({
      capability: scheduling,
      planFeature: { enabled: true, isUnlimited: true },
      used: 9_000,
      now: NOW,
    });
    expect(d.limit).toEqual({ kind: 'unlimited' });
    expect(d.remaining).toBeUndefined();
  });
});

describe('allowance', () => {
  const bounded = (used: number) =>
    resolveEntitlement({
      capability: scheduling,
      planFeature: { enabled: true, limitValue: 10, isUnlimited: false },
      used,
      now: NOW,
    });

  it('allows a request that fits', () => {
    expect(checkAllowance(bounded(0), 10)).toMatchObject({ allowed: true });
  });

  it('refuses a request that would exceed, distinctly from one already at the limit', () => {
    expect(checkAllowance(bounded(9), 2)).toMatchObject({
      allowed: false,
      reason: 'would_exceed_limit',
    });
    expect(checkAllowance(bounded(10), 1)).toMatchObject({
      allowed: false,
      reason: 'limit_reached',
    });
  });

  it('refuses anything at all when the capability is off', () => {
    const off = resolveEntitlement({ capability: analytics, now: NOW });
    expect(checkAllowance(off, 0)).toMatchObject({ allowed: false, reason: 'not_entitled' });
  });

  it('carries the decision into the verdict, so a refusal is explainable', () => {
    const verdict = checkAllowance(bounded(10), 1);
    expect(verdict.decision.source).toBe('plan');
    expect(verdict.decision.rule).toContain('plan');
  });
});
