/**
 * The permission catalogue.
 *
 * Permissions are `<module>.<resource>:<action>` literals (06-identity-and-access.md §3).
 * Declaring them as a `const` tuple gives BOTH properties the architecture depends on:
 *
 *   - an exhaustive union type, so a typo does not compile;
 *   - runtime enumerability, so the authorization matrix test covers EVERY permission
 *     automatically instead of the ones someone remembered to list.
 *
 * WHERE THIS LIVES, AND WHY IT IS NOT IN EACH MODULE'S CONTRACTS.
 * 06 §3 describes permissions as declared per module and "unioned into a single exhaustive
 * TypeScript type". A union assembled in @growth-os/authz would require authz to import
 * every module, which the `platform-must-not-import-modules` boundary rule forbids — and
 * that rule is load-bearing, since it is what keeps a module extractable later.
 *
 * So the catalogue is owned here and modules depend on it, rather than the reverse. Both
 * properties 06 §3 actually relies on are preserved; only the direction of the dependency
 * differs. Each module's contracts re-exports the slice it owns, so the module still states
 * its own surface.
 */

/**
 * Every permission in the system.
 *
 * Grouped by owning module. Adding one here is what makes it assignable to a role,
 * assertable in code, and covered by the matrix test — in that order, automatically.
 */
export const PERMISSIONS = [
  // ---- organization: tenancy, membership and access -----------------------------------
  'organization.organization:read',
  'organization.organization:update',
  'organization.organization:delete',
  'organization.member:read',
  'organization.member:invite',
  'organization.member:update',
  'organization.member:remove',
  'organization.team:read',
  'organization.team:create',
  'organization.team:update',
  'organization.team:delete',
  'organization.team_member:manage',
  'organization.workspace:read',
  'organization.workspace:create',
  'organization.workspace:update',
  'organization.workspace:archive',
  'organization.workspace_access:grant',
  'organization.role:read',
  'organization.role:create',
  'organization.role:update',
  'organization.role:delete',
  'organization.role_assignment:read',
  'organization.role_assignment:grant',
  'organization.role_assignment:revoke',
  'organization.api_key:read',
  'organization.api_key:create',
  'organization.api_key:revoke',
  'organization.audit_log:read',
  'organization.settings:read',
  'organization.settings:update',

  // ---- billing ------------------------------------------------------------------------
  'billing.subscription:read',
  'billing.subscription:manage',
  'billing.invoice:read',
  'billing.payment_method:manage',
  'billing.usage:read',

  // ---- integrations -------------------------------------------------------------------
  'integrations.connection:read',
  'integrations.connection:create',
  'integrations.connection:delete',
  // Deliberately separate from connection:read. Reading a connection's existence is
  // ordinary; reading its credentials is not, and client_guest and impersonation are both
  // denied this one specifically.
  'integrations.credential:read',

  // ---- social -------------------------------------------------------------------------
  'social.post:read',
  'social.post:create',
  'social.post:update',
  'social.post:delete',
  'social.post:approve',
  'social.post:publish',
  'social.comment:read',
  'social.comment:create',
  'social.calendar:read',
  'social.inbox:read',
  'social.inbox:reply',

  // ---- marketing ----------------------------------------------------------------------
  'marketing.campaign:read',
  'marketing.campaign:create',
  'marketing.campaign:update',
  'marketing.campaign:delete',
  'marketing.audience:read',
  'marketing.audience:manage',
  'marketing.attribution:read',

  // ---- crm ----------------------------------------------------------------------------
  'crm.contact:read',
  'crm.contact:create',
  'crm.contact:update',
  'crm.contact:delete',
  'crm.deal:read',
  'crm.deal:create',
  'crm.deal:update',
  'crm.deal:delete',

  // ---- marketplace --------------------------------------------------------------------
  'marketplace.listing:read',
  'marketplace.listing:create',
  'marketplace.listing:update',
  'marketplace.listing:publish',
  'marketplace.order:read',
  'marketplace.order:create',
  'marketplace.order:fulfil',
  'marketplace.payout:read',

  // ---- automation ---------------------------------------------------------------------
  'automation.workflow:read',
  'automation.workflow:create',
  'automation.workflow:update',
  'automation.workflow:delete',
  'automation.run:read',
  'automation.run:cancel',

  // ---- analytics ----------------------------------------------------------------------
  'analytics.report:read',
  'analytics.report:create',
  'analytics.export:create',
  // What a report cost to produce is agency-internal: a client must not see the agency's
  // margins. Separated from report:read for exactly that reason.
  'analytics.cost:read',

  // ---- intelligence / AI --------------------------------------------------------------
  'intelligence.recommendation:read',
  'intelligence.recommendation:apply',
  'intelligence.capability:invoke',
  'intelligence.budget:read',
  'intelligence.budget:manage',

  // ---- files and notifications --------------------------------------------------------
  'files.file:read',
  'files.file:upload',
  'files.file:delete',
  'notifications.notification:read',
  'notifications.preference:manage',
] as const;

/** Every permission literal. A typo in an `assert` call is a compile error. */
export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/** The module that owns a permission — the part before the first dot. */
export function permissionModule(permission: Permission): string {
  return permission.slice(0, permission.indexOf('.'));
}

/**
 * Permissions that read a secret or move money.
 *
 * Named as a set rather than re-derived per call site, because the two places that must
 * never hold them — `client_guest` and any impersonated session — are both security
 * boundaries, and a list rebuilt independently in two places drifts.
 */
export const SENSITIVE_PERMISSIONS: readonly Permission[] = [
  'integrations.credential:read',
  'billing.subscription:manage',
  'billing.payment_method:manage',
  'billing.invoice:read',
  'organization.api_key:read',
  'organization.api_key:create',
  'organization.api_key:revoke',
  'analytics.cost:read',
  'marketplace.payout:read',
  'intelligence.budget:manage',
];

/**
 * Permissions that act on the ORGANIZATION as a whole, with no workspace to scope them to.
 *
 * The scope of a permission is a property of the permission, not something a caller should
 * infer from its module prefix — `organization.workspace:read` lives in the organization
 * module but is exercised against one workspace, and guessing from the prefix silently
 * mis-scopes it.
 *
 * This set is what stops a workspace-scoped role from being handed an organization-wide
 * capability: a role built by filtering the catalogue (`viewer` from every `:read`) would
 * otherwise grant a single-workspace viewer the organization's billing and audit log.
 */
export const ORGANIZATION_SCOPED_PERMISSIONS: readonly Permission[] = [
  'organization.organization:read',
  'organization.organization:update',
  'organization.organization:delete',
  'organization.member:read',
  'organization.member:invite',
  'organization.member:update',
  'organization.member:remove',
  'organization.team:create',
  'organization.team:delete',
  'organization.role:read',
  'organization.role:create',
  'organization.role:update',
  'organization.role:delete',
  'organization.api_key:read',
  'organization.api_key:create',
  'organization.api_key:revoke',
  'organization.audit_log:read',
  'organization.settings:read',
  'organization.settings:update',
  'billing.subscription:read',
  'billing.subscription:manage',
  'billing.invoice:read',
  'billing.payment_method:manage',
  'billing.usage:read',
  'intelligence.budget:read',
  'intelligence.budget:manage',
];

/** Permissions exercised against a TEAM rather than a workspace. */
export const TEAM_SCOPED_PERMISSIONS: readonly Permission[] = [
  'organization.team:read',
  'organization.team:update',
  'organization.team_member:manage',
];

const ORG_SCOPED = new Set<string>(ORGANIZATION_SCOPED_PERMISSIONS);
const TEAM_SCOPED = new Set<string>(TEAM_SCOPED_PERMISSIONS);

/** Where a permission is exercised. Used to pick the resource a check is made against. */
export function permissionScope(permission: Permission): 'organization' | 'team' | 'workspace' {
  if (ORG_SCOPED.has(permission)) return 'organization';
  if (TEAM_SCOPED.has(permission)) return 'team';
  return 'workspace';
}
