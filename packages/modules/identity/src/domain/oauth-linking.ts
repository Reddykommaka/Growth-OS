/**
 * Account-linking rules for OAuth sign-in.
 *
 * Pure decisions over facts the caller has already established, so every dangerous case is
 * enumerable and testable without a provider, a database or a network.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a matching email address is NEVER sufficient to link
 * an OAuth identity to an existing account.
 *
 * The attack it prevents is concrete. Suppose linking were "same email ⇒ same person".
 * An attacker who can obtain a provider account bearing a victim's address — a provider that
 * does not verify addresses, a self-hosted OIDC issuer, a stale corporate directory entry,
 * or simply a provider that lets an address be changed after the fact — signs in with it and
 * is handed the victim's account, password untouched and MFA never challenged. Email is a
 * routing address, not an authentication factor, and treating it as one turns every
 * federation partner into a universal skeleton key.
 *
 * So the only automatic join key is the provider SUBJECT of an identity already linked by
 * someone who proved they controlled the account. Everything else requires the user to
 * authenticate to the existing account first, through the ordinary `link` flow.
 */

export type LinkingFacts = {
  /** An existing `user_identities` row for this (provider, subject), if any. */
  readonly linkedUserId: string | null;
  /** A user whose account email equals the provider's asserted address, if any. */
  readonly userWithSameEmail: { readonly id: string; readonly emailVerified: boolean } | null;
  /** Whether the PROVIDER asserts it verified the address. */
  readonly providerEmailVerified: boolean;
  /** Whether the provider returned an address at all. */
  readonly hasEmail: boolean;
};

export type LinkingDecision =
  /** The subject is already linked. Sign in as that user — the one safe automatic path. */
  | { readonly action: 'sign_in_existing'; readonly userId: string }
  /** No identity, no colliding account: provision a new user. */
  | { readonly action: 'create_user'; readonly emailVerified: boolean }
  /**
   * An account already holds this address. Refuse, and tell the user to sign in and link
   * from their settings. Never a session, never a merge.
   */
  | { readonly action: 'require_explicit_link'; readonly existingUserId: string }
  /** The provider returned no usable address, so no account can be provisioned. */
  | { readonly action: 'refuse'; readonly reason: 'no_email' | 'email_unverified' };

/**
 * Decides what a sign-in attempt may do.
 *
 * Ordered so the safe automatic path is first and every other branch narrows toward refusal.
 * There is deliberately no branch that creates a session for an account the provider did not
 * already prove a link to.
 */
export function decideLinking(facts: LinkingFacts): LinkingDecision {
  // Already linked: the subject is a durable key, established when someone who controlled
  // this account proved it. This is the ONLY automatic sign-in.
  if (facts.linkedUserId !== null) {
    return { action: 'sign_in_existing', userId: facts.linkedUserId };
  }

  // No address means no account can be created, and nothing to compare against.
  if (!facts.hasEmail) return { action: 'refuse', reason: 'no_email' };

  // An address the provider has not verified is an address anyone can claim. It cannot
  // create an account and it certainly cannot match one.
  if (!facts.providerEmailVerified) return { action: 'refuse', reason: 'email_unverified' };

  // The dangerous case, refused in BOTH directions.
  //
  // If our account is verified: two parties have now proven the same address, and only the
  // account holder can say whether they are the same person — so they must, by linking from
  // inside a session they can already open.
  //
  // If our account is NOT verified: the provider has proven ownership and we have not, so it
  // is tempting to hand the account over. That is precisely the takeover primitive. An
  // attacker who registers an unverified account against a victim's address would otherwise
  // have it silently converted into the victim's real account the first time the victim uses
  // OAuth — or, worse, the attacker signs in via a provider and inherits whatever the
  // unverified account has accumulated.
  if (facts.userWithSameEmail !== null) {
    return { action: 'require_explicit_link', existingUserId: facts.userWithSameEmail.id };
  }

  // A verified address with no existing account. The provider has proven ownership, so the
  // new user starts active rather than pending — asking them to verify an address a
  // federation partner just verified is friction with no security value.
  return { action: 'create_user', emailVerified: true };
}

export type ExplicitLinkFacts = {
  /** The user performing the link, from their authenticated session. */
  readonly sessionUserId: string;
  /** Any existing link for this (provider, subject). */
  readonly linkedUserId: string | null;
  /** Whether this user already has an identity with this provider. */
  readonly userAlreadyHasProvider: boolean;
};

export type ExplicitLinkDecision =
  | { readonly action: 'link' }
  | { readonly action: 'already_linked_to_self' }
  | {
      readonly action: 'refuse';
      readonly reason: 'linked_to_another_user' | 'provider_already_linked';
    };

/**
 * Decides whether an authenticated user may attach this provider identity.
 *
 * The refusal that matters is `linked_to_another_user`. Allowing a second user to claim an
 * identity already bound to someone else would let an attacker attach the victim's provider
 * subject to their own account and then sign in as the victim — the takeover arriving by the
 * back door instead of the front.
 */
export function decideExplicitLink(facts: ExplicitLinkFacts): ExplicitLinkDecision {
  if (facts.linkedUserId === facts.sessionUserId) return { action: 'already_linked_to_self' };
  if (facts.linkedUserId !== null) {
    return { action: 'refuse', reason: 'linked_to_another_user' };
  }
  // One identity per provider per user: a second would make "unlink Google" ambiguous, and
  // ambiguity in a credential-removal path is how a credential survives its own removal.
  if (facts.userAlreadyHasProvider) {
    return { action: 'refuse', reason: 'provider_already_linked' };
  }
  return { action: 'link' };
}

/**
 * Whether a provider's newly-asserted address should replace what the IDENTITY recorded.
 *
 * It updates the identity row only. It never touches the USER's account email: the provider
 * proving control of a new address says nothing about the account holder wanting their login
 * address changed, and a silent change there is an account takeover with extra steps. A real
 * email change goes through the `email_change` token flow, which proves control of both.
 */
export function shouldUpdateIdentityEmail(
  recorded: string | null,
  asserted: string | undefined,
  assertedVerified: boolean,
): boolean {
  if (asserted === undefined || !assertedVerified) return false;
  return recorded !== asserted;
}
