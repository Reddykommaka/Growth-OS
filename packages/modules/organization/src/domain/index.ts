/**
 * @growth-os/module-organization/domain
 *
 * Pure tenancy rules: no database, no clock, no I/O.
 */
export {
  addressMatchesInvitation,
  checkNoEscalation,
  type EscalationVerdict,
  INVITATION_TTL_MS,
  type InvitationFacts,
  type InvitationScope,
  type InvitationState,
  invitationState,
  memberTypeForRole,
  scopeMatchesRole,
} from './invitations.js';
