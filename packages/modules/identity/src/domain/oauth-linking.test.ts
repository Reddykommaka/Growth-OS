/**
 * The account-linking decision table, exhaustively.
 *
 * Pure facts in, one decision out — so every dangerous combination is enumerable without a
 * provider, a database or a network. The table below IS the security policy; if a row here
 * changes, the blast radius is every federated sign-in.
 */
import { describe, expect, it } from 'vitest';
import {
  decideExplicitLink,
  decideLinking,
  type LinkingFacts,
  shouldUpdateIdentityEmail,
} from './oauth-linking.js';

const base: LinkingFacts = {
  linkedUserId: null,
  userWithSameEmail: null,
  providerEmailVerified: true,
  hasEmail: true,
};

describe('the only automatic sign-in is an already-linked subject', () => {
  it('signs in when the provider subject is already linked', () => {
    expect(decideLinking({ ...base, linkedUserId: 'user-1' })).toEqual({
      action: 'sign_in_existing',
      userId: 'user-1',
    });
  });

  /**
   * A linked subject wins over everything else, including a colliding address and an
   * unverified provider claim — the link was established by someone who proved they held the
   * account, which is a stronger fact than any assertion in this callback.
   */
  it('signs in even when the address now collides or is unverified', () => {
    expect(
      decideLinking({
        ...base,
        linkedUserId: 'user-1',
        userWithSameEmail: { id: 'user-2', emailVerified: true },
        providerEmailVerified: false,
      }).action,
    ).toBe('sign_in_existing');
  });
});

describe('a matching email NEVER signs anyone in', () => {
  it.each([
    ['a verified local account', true],
    ['an UNVERIFIED local account', false],
  ])('requires an explicit link for %s', (_label, emailVerified) => {
    const decision = decideLinking({
      ...base,
      userWithSameEmail: { id: 'existing-user', emailVerified },
    });
    expect(decision).toEqual({ action: 'require_explicit_link', existingUserId: 'existing-user' });
  });

  /**
   * The unverified case is the one that looks safe to allow and is not. An attacker who
   * registers an unverified account against a victim's address would otherwise have it
   * silently converted the first time anyone federates with that address.
   */
  it('never returns a sign-in or a create for a colliding address', () => {
    for (const emailVerified of [true, false]) {
      for (const providerEmailVerified of [true, false]) {
        const decision = decideLinking({
          ...base,
          providerEmailVerified,
          userWithSameEmail: { id: 'existing', emailVerified },
        });
        expect(['require_explicit_link', 'refuse']).toContain(decision.action);
      }
    }
  });
});

describe('provisioning requires a provider-verified address', () => {
  it('creates a verified user for a verified address with no collision', () => {
    expect(decideLinking(base)).toEqual({ action: 'create_user', emailVerified: true });
  });

  it('refuses when the provider has not verified the address', () => {
    expect(decideLinking({ ...base, providerEmailVerified: false })).toEqual({
      action: 'refuse',
      reason: 'email_unverified',
    });
  });

  it('refuses when there is no address at all', () => {
    expect(decideLinking({ ...base, hasEmail: false })).toEqual({
      action: 'refuse',
      reason: 'no_email',
    });
  });

  /** Exhaustive: only ONE of the eight unlinked combinations may create an account. */
  it('creates an account in exactly one of the eight unlinked combinations', () => {
    const creating: string[] = [];
    for (const hasEmail of [true, false]) {
      for (const providerEmailVerified of [true, false]) {
        for (const collision of [null, { id: 'x', emailVerified: true }]) {
          const decision = decideLinking({
            linkedUserId: null,
            hasEmail,
            providerEmailVerified,
            userWithSameEmail: collision,
          });
          if (decision.action === 'create_user') {
            creating.push(
              `email=${hasEmail} verified=${providerEmailVerified} collision=${collision !== null}`,
            );
          }
        }
      }
    }
    expect(creating).toEqual(['email=true verified=true collision=false']);
  });
});

describe('explicit linking', () => {
  it('links an unclaimed identity to the session user', () => {
    expect(
      decideExplicitLink({
        sessionUserId: 'me',
        linkedUserId: null,
        userAlreadyHasProvider: false,
      }),
    ).toEqual({ action: 'link' });
  });

  it('is idempotent when already linked to the same user', () => {
    expect(
      decideExplicitLink({
        sessionUserId: 'me',
        linkedUserId: 'me',
        userAlreadyHasProvider: true,
      }),
    ).toEqual({ action: 'already_linked_to_self' });
  });

  /** The back-door takeover: claiming an identity bound to someone else. */
  it('REFUSES an identity bound to another user', () => {
    expect(
      decideExplicitLink({
        sessionUserId: 'attacker',
        linkedUserId: 'victim',
        userAlreadyHasProvider: false,
      }),
    ).toEqual({ action: 'refuse', reason: 'linked_to_another_user' });
  });

  it('refuses a second identity from a provider the user already has', () => {
    expect(
      decideExplicitLink({
        sessionUserId: 'me',
        linkedUserId: null,
        userAlreadyHasProvider: true,
      }),
    ).toEqual({ action: 'refuse', reason: 'provider_already_linked' });
  });
});

describe('a provider email change updates the identity, never the account', () => {
  it('updates when the provider verified a different address', () => {
    expect(shouldUpdateIdentityEmail('old@example.test', 'new@example.test', true)).toBe(true);
  });

  it('does nothing when the address is unchanged', () => {
    expect(shouldUpdateIdentityEmail('same@example.test', 'same@example.test', true)).toBe(false);
  });

  it('ignores an UNVERIFIED new address', () => {
    // Otherwise a provider that lets an address be set without proof could rewrite what we
    // recorded about the identity.
    expect(shouldUpdateIdentityEmail('old@example.test', 'new@example.test', false)).toBe(false);
  });

  it('ignores an absent address', () => {
    expect(shouldUpdateIdentityEmail('old@example.test', undefined, true)).toBe(false);
  });
});
