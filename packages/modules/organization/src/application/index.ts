/**
 * @growth-os/module-organization/application
 *
 * Invitation and API-key services. Dependencies arrive as ports, so the escalation and
 * lifecycle rules are testable without a database — and the properties that are properties
 * OF the database are tested against a real cluster.
 */

export {
  type ApiKeyAuthDependencies,
  type ApiKeyAuthResult,
  authenticateApiKey,
} from './api-key-auth.js';
export {
  type ApiKeyDependencies,
  type CreateApiKeyInput,
  type CreatedApiKey,
  createApiKey,
  listApiKeys,
  type RotateApiKeyResult,
  revokeApiKey,
  rotateApiKey,
} from './api-keys.js';
export {
  type AuditLogDependencies,
  type AuditLogPage,
  auditGenesis,
  type ReadAuditLogInput,
  readAuditLog,
  type VerifyAuditLogResult,
  verifyAuditLog,
} from './audit-log.js';
export {
  type AcceptDependencies,
  type AcceptInvitationInput,
  type AcceptOutcome,
  acceptInvitation,
} from './invitation-acceptance.js';
export {
  type CreatedInvitation,
  type CreateInvitationInput,
  createInvitation,
  type InvitationDependencies,
  resendInvitation,
  revokeInvitation,
} from './invitations.js';
export type {
  AdmitInput,
  ApiKeyRepository,
  ApiKeyRow,
  AuditEntry,
  AuditSink,
  Clock,
  InvitationDelivery,
  InvitationNotifier,
  InvitationRepository,
  InvitationRow,
  MembershipWriter,
  OrganizationReader,
  RateLimiter,
  RoleReader,
  RoleRecord,
  TenantScopedRepositories,
  TenantScopeFactory,
  WorkspaceTopologyReader,
} from './ports.js';
export { systemClock } from './ports.js';
