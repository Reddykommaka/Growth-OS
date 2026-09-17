/**
 * @growth-os/module-identity/infrastructure
 *
 * PostgreSQL-backed implementations of the identity ports, plus the composition helper that
 * wires them into the application services.
 */
export { createMfaRepository } from './mfa-repository.js';
export {
  createOAuthRequestRepository,
  createUserIdentityRepository,
} from './oauth-repository.js';
export { createOidcProvider, type OidcProviderConfig } from './oidc-provider.js';
export type { Queryable } from './queryable.js';
export { createSessionRepository } from './session-repository.js';
export {
  createIdentityUnitOfWork,
  type IdentityUnitOfWorkOptions,
} from './unit-of-work.js';
export { createUserRepository } from './user-repository.js';
export { createUserTokenRepository } from './user-token-repository.js';
