/**
 * Types shared by the two halves of the OAuth flow.
 *
 * They live here, not in either half, because `oauth.ts` (protocol) calls into
 * `oauth-flows.ts` (linking) while the flows need the dependency and outcome shapes. Putting
 * them in one of the two makes the pair circular — which dependency-cruiser caught.
 */
import type { SecretCipher } from '@growth-os/authn';
import type {
  OAuthProviderRegistry,
  OAuthPurpose,
  OAuthRequestRepository,
  ProviderId,
  UserIdentityRepository,
} from './oauth-port.js';
import type {
  AuditSink,
  AuthRateLimiter,
  Clock,
  SessionRepository,
  UserRepository,
} from './ports.js';
import type { IdentityUnitOfWork } from './unit-of-work.js';

/** Ten minutes, matching the connection flow in 07 §2. Long enough to consent, short enough
 *  that a stolen row is worthless by the time it is found. */
export const OAUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

export interface OAuthDependencies {
  /** The transaction these writes and their audit events commit within. */
  readonly unitOfWork: IdentityUnitOfWork;
  readonly providers: OAuthProviderRegistry;
  readonly oauthRequests: OAuthRequestRepository;
  readonly identities: UserIdentityRepository;
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly audit: AuditSink;
  readonly clock: Clock;
  readonly cipher: SecretCipher;
  readonly rateLimiter?: AuthRateLimiter | undefined;
}

export interface BeginOAuthInput {
  readonly provider: ProviderId;
  readonly purpose: OAuthPurpose;
  readonly redirectUri: string;
  /** Required for 'link', forbidden for 'sign_in'. */
  readonly linkUserId?: string | undefined;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface BeginOAuthResult {
  readonly authorizationUrl: string;
  /** For the caller to set as a short-lived cookie if it wants double-submit protection. */
  readonly state: string;
}

export type OAuthOutcome =
  | {
      readonly outcome: 'authenticated';
      readonly userId: string;
      readonly sessionId: string;
      readonly token: string;
      readonly expiresAt: Date;
      readonly createdUser: boolean;
    }
  | { readonly outcome: 'linked'; readonly userId: string }
  | { readonly outcome: 'already_linked'; readonly userId: string }
  /** An account holds this address. The user must sign in and link from settings. */
  | { readonly outcome: 'link_required'; readonly email: string }
  | { readonly outcome: 'rate_limited' }
  | {
      readonly outcome: 'failed';
      readonly reason:
        | 'invalid_state'
        | 'expired'
        | 'replayed'
        | 'exchange_failed'
        | 'no_email'
        | 'email_unverified'
        | 'linked_to_another_user'
        | 'provider_already_linked'
        | 'account_unavailable';
    };

export interface CompleteOAuthInput {
  readonly provider: ProviderId;
  /** The full callback URL, so the library can verify state and read the code itself. */
  readonly callbackUrl: string;
  readonly state: string;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly deviceLabel?: string | undefined;
}
