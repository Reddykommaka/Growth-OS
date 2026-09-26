/**
 * What an event is allowed to be.
 *
 * These are cheap and they guard two things that are expensive to discover later: a name that
 * no consumer can subscribe to by prefix, and a payload carrying a secret into Redis, consumer
 * logs and the dead-letter queue — infrastructure the transaction's blast radius does not
 * cover.
 */
import { describe, expect, it } from 'vitest';
import { assertPublishable, type DomainEvent } from './event.js';

const event = (over: Partial<DomainEvent> = {}): DomainEvent => ({
  name: 'social.post.published',
  organizationId: '11111111-1111-4111-8111-111111111111',
  payload: { postId: 'p1' },
  ...over,
});

describe('event names', () => {
  it('accepts module.aggregate.verb', () => {
    expect(() => assertPublishable(event())).not.toThrow();
    expect(() => assertPublishable(event({ name: 'marketplace.order.line_added' }))).not.toThrow();
    // Four segments are fine: a sub-aggregate is still prefix-subscribable.
    expect(() => assertPublishable(event({ name: 'identity.user.mfa.enrolled' }))).not.toThrow();
  });

  it('refuses a name with fewer than three segments', () => {
    // The relay routes on the name and the automation engine binds triggers to it, so
    // "postPublished" works right up until something subscribes to a family by prefix.
    expect(() => assertPublishable(event({ name: 'postPublished' }))).toThrow(/wire contract/);
    expect(() => assertPublishable(event({ name: 'social.published' }))).toThrow(/wire contract/);
  });

  it('refuses uppercase and camelCase segments', () => {
    expect(() => assertPublishable(event({ name: 'Social.Post.Published' }))).toThrow();
    expect(() => assertPublishable(event({ name: 'social.post.wasPublished' }))).toThrow();
  });

  it('refuses an empty or punctuation-only name', () => {
    for (const name of ['', '.', '..', 'social..published', '.social.post.published']) {
      expect(() => assertPublishable(event({ name })), name).toThrow();
    }
  });
});

describe('versions', () => {
  it('defaults to 1 and accepts any positive integer', () => {
    expect(() => assertPublishable(event())).not.toThrow();
    expect(() => assertPublishable(event({ version: 3 }))).not.toThrow();
  });

  it('refuses zero, negative and fractional versions', () => {
    for (const version of [0, -1, 1.5]) {
      expect(() => assertPublishable(event({ version })), String(version)).toThrow(/version/);
    }
  });
});

describe('payload secrets', () => {
  const forbidden = [
    'password',
    'passwordHash',
    'secret',
    'clientSecret',
    'token',
    'refreshToken',
    'apiKey',
    'api_key',
    'privateKey',
    'credential',
    'authorization',
    'mfaSecret',
    'totpSecret',
    'recoveryCodes',
    'sessionId',
    'cookie',
  ];

  for (const key of forbidden) {
    it(`refuses a payload carrying ${key}`, () => {
      expect(() => assertPublishable(event({ payload: { [key]: 'x' } }))).toThrow(/forbidden/);
    });
  }

  it('finds one nested inside an object or an array', () => {
    // A shallow check would pass both of these, which is the whole failure mode: nobody puts
    // a secret at the top level of a payload on purpose.
    expect(() =>
      assertPublishable(event({ payload: { connection: { accessToken: 'x' } } })),
    ).toThrow(/connection.accessToken/);
    expect(() =>
      assertPublishable(event({ payload: { accounts: [{ ok: 1 }, { apiKey: 'x' }] } })),
    ).toThrow(/accounts.1.apiKey/);
  });

  it('allows a reference to a secret by identity', () => {
    // An event must be able to say WHICH credential was used without carrying it. Refusing
    // these would push callers into renaming the field to get past the check, which is worse
    // than allowing the two names that are genuinely safe.
    expect(() => assertPublishable(event({ payload: { apiKeyId: 'ak_1' } }))).not.toThrow();
    expect(() => assertPublishable(event({ payload: { tokenHash: 'abc' } }))).not.toThrow();
  });

  it('survives a null value without treating it as an object', () => {
    expect(() => assertPublishable(event({ payload: { nothing: null } }))).not.toThrow();
  });
});

describe('tenancy', () => {
  it('refuses an event with no organization', () => {
    expect(() => assertPublishable(event({ organizationId: '' }))).toThrow(/no organization/);
  });
});
