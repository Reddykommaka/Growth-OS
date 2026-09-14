/**
 * System role definitions (06-identity-and-access.md §3).
 *
 * Roles are data. These are the built-in rows seeded into the `roles` table with
 * organization_id NULL — shared by every tenant, so a permission added to a system role
 * reaches organizations that already exist. Custom roles are per-organization rows with the
 * same shape.
 */
import {
  PERMISSIONS,
  type Permission,
  permissionScope,
  SENSITIVE_PERMISSIONS,
} from './permissions.js';

export type RoleScope = 'organization' | 'team' | 'workspace';

export interface SystemRole {
  readonly slug: string;
  readonly name: string;
  readonly scope: RoleScope;
  readonly description: string;
  readonly permissions: readonly Permission[];
}

const ALL: readonly Permission[] = PERMISSIONS;

/** Everything except the permissions that manage the organization's own existence. */
const allExcept = (excluded: readonly Permission[]): readonly Permission[] => {
  const drop = new Set<string>(excluded);
  return ALL.filter((p) => !drop.has(p));
};

const READ_ONLY: readonly Permission[] = ALL.filter((p) => p.endsWith(':read'));

/**
 * Reads exercisable inside ONE workspace.
 *
 * `viewer` and `client_guest` are workspace-scoped. Building them from every `:read` in the
 * catalogue handed a single-workspace viewer the organization's billing, audit log and
 * member list — an over-grant that read as a one-word filter. The matrix caught it; this
 * constant is the fix, and `isWorkspaceScoped` is why it cannot silently return.
 */
const isWorkspaceScoped = (p: Permission): boolean => permissionScope(p) === 'workspace';
const WORKSPACE_READ_ONLY: readonly Permission[] = READ_ONLY.filter(isWorkspaceScoped);

/**
 * Workspace-scoped permissions a client's own reviewer may hold.
 *
 * This is an ALLOW-LIST, deliberately. `client_guest` is held by someone outside the tenant
 * organization entirely — the most security-sensitive role in the system (06 §3) — and a
 * deny-list would grant every permission added in a later phase by default. An allow-list
 * fails the other way: a new permission is unavailable to a guest until someone decides it
 * should be.
 */
const CLIENT_GUEST_PERMISSIONS: readonly Permission[] = [
  'organization.workspace:read',
  'social.post:read',
  'social.post:approve',
  'social.comment:read',
  'social.comment:create',
  'social.calendar:read',
  'marketing.campaign:read',
  'analytics.report:read',
  'files.file:read',
  'notifications.notification:read',
  'notifications.preference:manage',
];

const SENSITIVE = new Set<string>(SENSITIVE_PERMISSIONS);
function isSensitive(permission: Permission): boolean {
  return SENSITIVE.has(permission);
}

/**
 * Whether a permission is product work rather than tenancy administration.
 *
 * Used to compose the working roles without listing sixty literals in each, while keeping
 * organization-management permissions out of them by construction.
 *
 * The scope test is not redundant with the module test. `intelligence.budget:read` is an
 * organization-level financial control that happens to live in a product module, so a
 * module-name check alone let every workspace editor read the tenant's AI spend cap. Both
 * conditions are needed: the module test keeps tenancy admin out, the scope test keeps
 * organization-wide controls out wherever they live.
 */
function isWorkingPermission(permission: Permission): boolean {
  const module = permission.slice(0, permission.indexOf('.'));
  if (module === 'organization' || module === 'billing') return false;
  return permissionScope(permission) !== 'organization';
}

// NOTE: both helpers and the SENSITIVE set must be declared ABOVE this array. SYSTEM_ROLES
// is built during module evaluation and calls them, so declaring them below puts the Set in
// its temporal dead zone — a ReferenceError at import time that typechecks perfectly.

export const SYSTEM_ROLES: readonly SystemRole[] = [
  {
    slug: 'owner',
    name: 'Owner',
    scope: 'organization',
    description: 'Full control, including deleting the organization and managing billing.',
    permissions: ALL,
  },
  {
    slug: 'admin',
    name: 'Administrator',
    scope: 'organization',
    description: 'Full control except deleting the organization itself.',
    permissions: allExcept(['organization.organization:delete']),
  },
  {
    slug: 'billing',
    name: 'Billing',
    scope: 'organization',
    description: 'Finance access: subscription, invoices and usage, with no product access.',
    permissions: [
      'organization.organization:read',
      'billing.subscription:read',
      'billing.subscription:manage',
      'billing.invoice:read',
      'billing.payment_method:manage',
      'billing.usage:read',
    ],
  },
  {
    slug: 'analyst',
    name: 'Analyst',
    scope: 'organization',
    description: 'Reads everything reportable across the organization; changes nothing.',
    permissions: [...READ_ONLY, 'analytics.report:create', 'analytics.export:create'],
  },
  {
    slug: 'member',
    name: 'Member',
    scope: 'organization',
    description:
      'Belongs to the organization with no inherent access. Access arrives through team ' +
      'membership or a workspace role — the default for agency staff.',
    permissions: ['organization.organization:read'],
  },
  {
    slug: 'team_lead',
    name: 'Team lead',
    scope: 'team',
    description:
      'Full working access to every workspace the team serves, including clients added ' +
      'to the team next month, plus the ability to staff the team.',
    permissions: [
      'organization.team:read',
      'organization.team_member:manage',
      'organization.workspace:read',
      'organization.workspace:update',
      ...allExcept([...SENSITIVE_PERMISSIONS, 'organization.organization:delete']).filter((p) =>
        isWorkingPermission(p),
      ),
    ],
  },
  {
    slug: 'team_member',
    name: 'Team member',
    scope: 'team',
    description: 'Working access to every workspace the team serves.',
    permissions: [
      'organization.team:read',
      'organization.workspace:read',
      ...allExcept([...SENSITIVE_PERMISSIONS, 'social.post:publish']).filter((p) =>
        isWorkingPermission(p),
      ),
    ],
  },
  {
    slug: 'workspace_admin',
    name: 'Workspace administrator',
    scope: 'workspace',
    description: 'Full control of one workspace, including who else may access it.',
    permissions: [
      'organization.workspace:read',
      'organization.workspace:update',
      'organization.workspace:archive',
      'organization.role_assignment:read',
      'organization.role_assignment:grant',
      'organization.role_assignment:revoke',
      ...allExcept(SENSITIVE_PERMISSIONS).filter((p) => isWorkingPermission(p)),
    ],
  },
  {
    slug: 'editor',
    name: 'Editor',
    scope: 'workspace',
    description: 'Creates and edits work in one workspace, and may publish it.',
    permissions: [
      'organization.workspace:read',
      ...allExcept(SENSITIVE_PERMISSIONS).filter((p) => isWorkingPermission(p)),
    ],
  },
  {
    slug: 'contributor',
    name: 'Contributor',
    scope: 'workspace',
    description: 'Creates and edits work, but cannot approve or publish it.',
    permissions: [
      'organization.workspace:read',
      ...allExcept([...SENSITIVE_PERMISSIONS, 'social.post:approve', 'social.post:publish']).filter(
        (p) => isWorkingPermission(p),
      ),
    ],
  },
  {
    slug: 'approver',
    name: 'Approver',
    scope: 'workspace',
    description: 'Reviews and approves work without authoring it.',
    permissions: [
      'organization.workspace:read',
      'social.post:read',
      'social.post:approve',
      'social.post:publish',
      'social.comment:read',
      'social.comment:create',
      'social.calendar:read',
      'marketing.campaign:read',
      'analytics.report:read',
      'files.file:read',
    ],
  },
  {
    slug: 'viewer',
    name: 'Viewer',
    scope: 'workspace',
    description: 'Reads work in one workspace and changes nothing.',
    permissions: [
      'organization.workspace:read',
      ...WORKSPACE_READ_ONLY.filter((p) => !isSensitive(p)),
    ],
  },
  {
    slug: 'client_guest',
    name: 'Client guest',
    scope: 'workspace',
    description:
      "The client's own reviewer. Sees and approves their own work only — never the " +
      "agency's other clients, its costs, its staff or its integrations.",
    permissions: CLIENT_GUEST_PERMISSIONS,
  },
];

export function systemRole(slug: string, scope: RoleScope): SystemRole | undefined {
  return SYSTEM_ROLES.find((r) => r.slug === slug && r.scope === scope);
}
