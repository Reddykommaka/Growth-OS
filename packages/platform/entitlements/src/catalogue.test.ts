/**
 * The catalogue's own invariants.
 *
 * These are cheap and they guard the two mistakes a code catalogue is actually prone to: a
 * key that disagrees with the module it claims, and a fallback that contradicts the limit
 * kind it is declared under. Neither shows up as a type error, and both produce a resolver
 * that is confidently wrong.
 */
import { describe, expect, it } from 'vitest';
import { capability, capabilityKeys, unknownCapabilityKeys } from './catalogue.js';

const all = () => capabilityKeys().map((key) => capability(key));

describe('the capability catalogue', () => {
  it('declares every key exactly once', () => {
    const keys = capabilityKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('resolves every declared key', () => {
    for (const key of capabilityKeys()) {
      expect(capability(key), key).toBeDefined();
    }
  });

  it('names each capability after the module that owns it', () => {
    // A key whose prefix disagrees with its module is how a capability ends up consulted by
    // one module and priced under another.
    for (const declared of all()) {
      expect(declared?.key.startsWith(`${declared.module}.`), declared?.key).toBe(true);
    }
  });

  it('gives a boolean capability no numeric fallback', () => {
    for (const declared of all()) {
      if (declared?.limit === 'boolean') {
        expect(declared.fallback.limit, declared.key).toBeUndefined();
      }
    }
  });

  it('never declares a positive fallback allowance on a capability that is off by default', () => {
    // "Disabled, but with an allowance of 5" is not a state the resolver can express: the
    // enabled flag decides, and the limit is never consulted. A catalogue entry claiming it
    // would resolve as plainly disabled, silently, and the plan that was meant to be
    // generous would look broken. An explicit `limit: 0` is fine and is how the catalogue
    // says "none of these" out loud.
    for (const declared of all()) {
      if (declared?.fallback.enabled === false && declared.fallback.limit !== undefined) {
        expect(declared.fallback.limit, declared.key).toBe(0);
      }
    }
  });

  it('declares a non-negative fallback limit where it declares one at all', () => {
    for (const declared of all()) {
      if (declared?.fallback.limit !== undefined) {
        expect(declared.fallback.limit, declared.key).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('covers all four product areas, so no product is retrofitted later', () => {
    const modules = new Set(all().map((c) => c?.module));
    // 01-overview.md §1: "All three products are first-class from the start."
    expect(modules).toContain('social');
    expect(modules).toContain('marketing');
    expect(modules).toContain('marketplace');
    expect(modules).toContain('ai');
  });

  it('reports an unknown key rather than resolving it to something', () => {
    expect(capability('social.does_not_exist')).toBeUndefined();
    expect(unknownCapabilityKeys(['social.does_not_exist', ...capabilityKeys()])).toEqual([
      'social.does_not_exist',
    ]);
  });
});
