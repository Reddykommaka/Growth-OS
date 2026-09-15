/**
 * @growth-os/authz — the authorization layer.
 *
 * Layer 1 of the three in 06-identity-and-access.md §3. RLS (layer 2) and GRANTs (layer 3)
 * are independently sufficient to deny; none of them substitutes for another.
 */
export type {
  ActorContext,
  ActorKind,
  ResourceGrant,
  RoleAssignment,
} from './actor.js';
export {
  type AuthzDecision,
  assertPermission,
  type DecideOptions,
  type DenyReason,
  decide,
  type GrantSource,
  type ResourceRef,
} from './engine.js';
export {
  isPermission,
  PERMISSIONS,
  type Permission,
  permissionModule,
  permissionScope,
  SENSITIVE_PERMISSIONS,
} from './permissions.js';
export { type RoleScope, SYSTEM_ROLES, type SystemRole, systemRole } from './roles.js';
export {
  grantsOrganizationWideWorkspaceAccess,
  type ResolvedWorkspaceSet,
  resolveAccessibleWorkspaces,
  toPostgresArrayLiteral,
  type WorkspaceSetInput,
} from './workspace-set.js';
