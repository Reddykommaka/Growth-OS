/**
 * The canonical form and the hash over it.
 *
 * Every guarantee the chain makes reduces to two properties asserted here: the same event
 * always encodes to the same bytes, and two different events never do. The second is the one
 * that gets lost quietly — a hash that ignores a field, or a framing that lets two field
 * layouts collide, produces a chain that verifies a forgery.
 */
import { describe, expect, it } from 'vitest';
import { canonicalBytes, canonicalJson, genesisHash, hashEvent } from './canonical.js';
import type { AuditEventRecord } from './event.js';

const ORG = '01900000-0000-7000-8000-00000000aaaa';
const OTHER_ORG = '01900000-0000-7000-8000-00000000bbbb';

type Unsealed = Omit<AuditEventRecord, 'hash' | 'prevHash'>;

function event(overrides: Partial<Unsealed> = {}): Unsealed {
  return {
    id: '01900000-0000-7000-8000-00000000e001',
    organizationId: ORG,
    sequence: 1,
    occurredAt: new Date('2026-09-17T10:00:00.000Z'),
    actor: { type: 'user', userId: '01900000-0000-7000-8000-00000000u001' },
    action: 'organization.api_key.revoked',
    resourceType: 'api_key',
    resourceId: 'key-1',
    workspaceId: null,
    result: 'succeeded',
    ip: '10.0.0.1',
    userAgent: 'gos-test',
    requestId: 'req-1',
    metadata: { prefix: 'abc' },
    ...overrides,
  };
}

describe('determinism', () => {
  it('encodes the same event to the same bytes', () => {
    expect(canonicalBytes(event())).toEqual(canonicalBytes(event()));
  });

  /**
   * The realistic drift: an event built in code has its keys in literal order, the same event
   * read back from jsonb has them in whatever order PostgreSQL returns. If key order reached
   * the hash, every round-tripped row would fail verification.
   */
  it('is unaffected by metadata key order', () => {
    const a = event({ metadata: { alpha: 1, beta: 2, gamma: { x: 1, y: 2 } } });
    const b = event({ metadata: { gamma: { y: 2, x: 1 }, beta: 2, alpha: 1 } });
    expect(hashEvent(a, genesisHash(ORG))).toEqual(hashEvent(b, genesisHash(ORG)));
  });

  it('keeps array order, because reordering an array is a real change', () => {
    const a = event({ metadata: { scopes: ['read', 'write'] } });
    const b = event({ metadata: { scopes: ['write', 'read'] } });
    expect(hashEvent(a, genesisHash(ORG))).not.toEqual(hashEvent(b, genesisHash(ORG)));
  });

  it('drops undefined members exactly as the database will have done', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    // null is a stored value and must NOT collapse into absence.
    expect(canonicalJson({ a: 1, b: null })).not.toBe(canonicalJson({ a: 1 }));
  });
});

describe('every covered field changes the hash', () => {
  const base = event();
  const prev = genesisHash(ORG);
  const baseline = hashEvent(base, prev);

  const variants: ReadonlyArray<readonly [string, Partial<Unsealed>]> = [
    ['id', { id: '01900000-0000-7000-8000-00000000e002' }],
    ['organizationId', { organizationId: OTHER_ORG }],
    ['sequence', { sequence: 2 }],
    ['occurredAt', { occurredAt: new Date('2026-09-17T10:00:00.001Z') }],
    ['actor.type', { actor: { type: 'system' } }],
    ['actor.userId', { actor: { type: 'user', userId: 'someone-else' } }],
    [
      'actor.impersonatorUserId',
      {
        actor: {
          type: 'user',
          userId: '01900000-0000-7000-8000-00000000u001',
          impersonatorUserId: 'support-1',
        },
      },
    ],
    ['action', { action: 'organization.api_key.created' }],
    ['resourceType', { resourceType: 'invitation' }],
    ['resourceId', { resourceId: 'key-2' }],
    ['workspaceId', { workspaceId: '01900000-0000-7000-8000-00000000w001' }],
    ['result', { result: 'denied' }],
    ['ip', { ip: '10.0.0.2' }],
    ['userAgent', { userAgent: 'other' }],
    ['requestId', { requestId: 'req-2' }],
    ['metadata', { metadata: { prefix: 'abd' } }],
  ];

  for (const [name, override] of variants) {
    it(`changing ${name} changes the hash`, () => {
      expect(hashEvent(event(override), prev)).not.toEqual(baseline);
    });
  }

  it('changing the previous hash changes the hash', () => {
    expect(hashEvent(base, genesisHash(OTHER_ORG))).not.toEqual(baseline);
  });
});

describe('framing is unambiguous', () => {
  /**
   * The concatenation attack. Without length prefixes, ("ab","c") and ("a","bc") both encode
   * to "abc" — so an event could be re-encoded as a DIFFERENT event with the same hash, and
   * the chain would verify the forgery.
   */
  it('two field splits that concatenate alike do not collide', () => {
    const a = hashEvent(event({ resourceType: 'ab', resourceId: 'c' }), genesisHash(ORG));
    const b = hashEvent(event({ resourceType: 'a', resourceId: 'bc' }), genesisHash(ORG));
    expect(a).not.toEqual(b);
  });

  it('an absent optional field is distinct from an empty one', () => {
    const absent = hashEvent(event({ requestId: null }), genesisHash(ORG));
    const empty = hashEvent(event({ requestId: '' }), genesisHash(ORG));
    expect(absent).not.toEqual(empty);
  });
});

describe('genesis', () => {
  it('is derived from the organization, so a chain cannot be spliced onto another', () => {
    expect(genesisHash(ORG)).not.toEqual(genesisHash(OTHER_ORG));
  });

  it('is stable across calls, and 32 bytes', () => {
    expect(genesisHash(ORG)).toEqual(genesisHash(ORG));
    expect(genesisHash(ORG)).toHaveLength(32);
  });
});
