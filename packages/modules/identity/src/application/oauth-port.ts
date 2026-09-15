/**
 * The OAuth/OIDC provider port.
 *
 * The identity module depends on THIS, never on a provider. Adding Microsoft, GitHub or
 * Apple is a new entry in the provider registry and a configuration row — no change to the
 * linking rules, the session logic or anything else in this module, which is the property
 * 06-identity-and-access.md §2 asks for.
 *
 * The port is deliberately narrow: build a URL, then exchange a callback for a VERIFIED
 * identity. Everything protocol-shaped — discovery, PKCE, `state`, `nonce`, ID-token
 * signature verification, JWKS rotation — happens behind it, because that is a large surface
 * with a long history of subtle breaks and is exactly what ADR-0017 declined to hand-write.
 */

/** A provider the installation has configured. Not an enum — the set is deployment data. */
export type ProviderId = string;

/**
 * What an authorization request produced: the URL to send the user to, and the three secrets
 * the callback must be checked against.
 *
 * Returned together from one call because they are generated together. Splitting the
 * generation across the application layer and the adapter is how a `state` ends up in the
 * URL that does not match the one recorded.
 */
export interface StartedAuthorization {
  readonly url: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce: string;
}

/**
 * An identity the provider has VERIFIED — not merely asserted.
 *
 * By the time one of these exists, the ID token's signature, issuer, audience, expiry and
 * nonce have all been checked. `emailVerified` is the provider's own claim about the
 * address, and it is the single most security-relevant field here: the linking rules refuse
 * to act on an unverified one, because an address a provider has not verified is an address
 * anyone can claim.
 */
export interface VerifiedProviderIdentity {
  readonly provider: ProviderId;
  /** The provider's stable subject. The only durable join key — an email is not one. */
  readonly providerUserId: string;
  readonly email: string | undefined;
  readonly emailVerified: boolean;
  readonly name: string | undefined;
}

export interface OAuthProvider {
  readonly id: ProviderId;
  /** Human-readable, for the sign-in button and audit entries. */
  readonly displayName: string;
  /**
   * The exact redirect URIs this provider may return to.
   *
   * An allowlist, checked on both legs: the authorization request may only name one of
   * these, and the callback must match the one the request recorded. An open redirect here
   * hands an attacker the authorization code.
   */
  readonly allowedRedirectUris: readonly string[];

  /**
   * Mints `state`, a PKCE verifier and a `nonce`, and builds the authorization URL.
   *
   * Generation lives in the adapter so the library produces all three, with the entropy and
   * the S256 challenge derivation it already implements correctly.
   */
  startAuthorization(redirectUri: string): Promise<StartedAuthorization>;

  /**
   * Exchanges the callback for a verified identity.
   *
   * Throws on ANY protocol failure — bad state, bad PKCE verifier, expired or replayed code,
   * a signature that does not verify, a nonce that does not match. The caller maps that to a
   * single opaque outcome, so the failure mode is never an oracle.
   */
  exchangeCallback(params: {
    readonly callbackUrl: string;
    readonly expectedState: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<VerifiedProviderIdentity>;
}

/** The configured providers, by id. Empty is valid: an installation may not offer OAuth. */
export interface OAuthProviderRegistry {
  get(id: ProviderId): OAuthProvider | undefined;
  list(): readonly OAuthProvider[];
}

export function createProviderRegistry(providers: readonly OAuthProvider[]): OAuthProviderRegistry {
  const byId = new Map(providers.map((p) => [p.id, p]));
  return {
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
  };
}

export type OAuthPurpose = 'sign_in' | 'link';

export interface OAuthRequestRow {
  readonly id: string;
  readonly provider: ProviderId;
  readonly pkceVerifierEncrypted: Buffer;
  readonly nonceEncrypted: Buffer;
  readonly redirectUri: string;
  readonly purpose: OAuthPurpose;
  readonly linkUserId: string | null;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface OAuthRequestRepository {
  create(input: {
    readonly id: string;
    readonly provider: ProviderId;
    readonly stateHash: Buffer;
    readonly pkceVerifierEncrypted: Buffer;
    readonly nonceEncrypted: Buffer;
    readonly redirectUri: string;
    readonly purpose: OAuthPurpose;
    readonly linkUserId?: string | undefined;
    readonly ip?: string | undefined;
    readonly userAgent?: string | undefined;
    readonly expiresAt: Date;
  }): Promise<void>;

  findByStateHash(stateHash: Buffer): Promise<OAuthRequestRow | undefined>;

  /**
   * Marks a request consumed, returning false if it ALREADY was.
   *
   * Single-use decided by the write, not by a prior read — the same reason as every other
   * token in this system. A replayed callback races an honest one, and exactly one may win.
   */
  consume(id: string, at: Date): Promise<boolean>;

  deleteExpired(before: Date): Promise<number>;
}

export interface UserIdentityRow {
  readonly id: string;
  readonly userId: string;
  readonly provider: ProviderId;
  readonly providerUserId: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
}

export interface UserIdentityRepository {
  findByProviderSubject(
    provider: ProviderId,
    providerUserId: string,
  ): Promise<UserIdentityRow | undefined>;
  listForUser(userId: string): Promise<UserIdentityRow[]>;
  link(input: {
    readonly id: string;
    readonly userId: string;
    readonly provider: ProviderId;
    readonly providerUserId: string;
    readonly email: string | undefined;
    readonly emailVerified: boolean;
    readonly at: Date;
  }): Promise<void>;
  recordUse(id: string, at: Date, email: string | undefined, emailVerified: boolean): Promise<void>;
  unlink(userId: string, provider: ProviderId): Promise<boolean>;
}
