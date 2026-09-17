/**
 * Evaluation order, escalation attempts, ownership, resource grants and impersonation
 * (11-testing-architecture.md §3).
 *
 * These are the cases where a plausible-looking policy engine is wrong in a way that only
 * shows up as a breach, so each asserts behaviour rather than shape.
 */
import { ForbiddenError, toProblemDetails } from '@growth-os/errors';
import { describe, expect, it } from 'vitest';
import { actor, denialReason, grantSource, POD, WS_A, WS_B } from './__testing__/actors.js';
import { assertPermission, decide } from './engine.js';

const editorIn = (workspaceId: string) => ({
  roleId: 'editor',
  permissions: ['crm.deal:update', 'crm.deal:read'] as const,
  workspaceId,
});

describe('default deny', () => {
  it('denies an actor with no assignments at all', () => {
    const d = decide(actor(), 'crm.deal:read', { type: 'deal', id: 'd1', workspaceId: WS_A });
    expect(d).toEqual({ allowed: false, reason: 'no_grant' });
  });
});

describe('denials take precedence over every grant', () => {
  it('a suspended organization denies product work even for an owner', () => {
    const owner = actor({
      organizationStatus: 'suspended',
      assignments: [{ roleId: 'owner', permissions: ['crm.deal:update'] }],
    });
    expect(decide(owner, 'crm.deal:update', { type: 'deal', id: 'd', workspaceId: WS_A })).toEqual({
      allowed: false,
      reason: 'organization_suspended',
    });
  });

  it('but still lets them read the organization and reach billing to fix it', () => {
    const owner = actor({
      organizationStatus: 'suspended',
      assignments: [
        {
          roleId: 'owner',
          permissions: ['organization.organization:read', 'billing.subscription:manage'],
        },
      ],
    });
    expect(decide(owner, 'organization.organization:read').allowed).toBe(true);
    expect(decide(owner, 'billing.subscription:manage').allowed).toBe(true);
  });

  it('unsatisfied required MFA denies everything, whatever the role', () => {
    const a = actor({
      mfaRequired: true,
      mfaSatisfied: false,
      assignments: [{ roleId: 'owner', permissions: ['crm.deal:read'] }],
    });
    expect(decide(a, 'crm.deal:read', { type: 'deal', id: 'd', workspaceId: WS_A })).toEqual({
      allowed: false,
      reason: 'mfa_required',
    });
  });

  it('an actor with no membership row is not a tenant, whatever roles they carry', () => {
    const a = actor({
      organizationMemberId: undefined,
      assignments: [{ roleId: 'owner', permissions: ['crm.deal:read'] }],
    });
    expect(denialReason(decide(a, 'crm.deal:read'))).toBe('not_a_member');
  });
});

describe('escalation attempts', () => {
  it('a workspace_admin in workspace A has nothing in workspace B', () => {
    const a = actor({
      assignments: [editorIn(WS_A)],
      accessibleWorkspaceIds: [WS_A],
    });
    const d = decide(a, 'crm.deal:update', { type: 'deal', id: 'd', workspaceId: WS_B });
    expect(d).toEqual({ allowed: false, reason: 'workspace_not_accessible' });
  });

  it('a member cannot grant themselves a role they do not hold', () => {
    const member = actor({
      assignments: [{ roleId: 'member', permissions: ['organization.organization:read'] }],
    });
    expect(decide(member, 'organization.role_assignment:grant').allowed).toBe(false);
  });

  it('a team-scoped role cannot authorise an organization-level action', () => {
    const lead = actor({
      teamIds: [POD],
      workspacesByTeam: new Map([[POD, [WS_A]]]),
      assignments: [
        { roleId: 'team_lead', permissions: ['organization.member:remove'], teamId: POD },
      ],
    });
    expect(decide(lead, 'organization.member:remove').allowed).toBe(false);
  });

  it('a team-scoped role reaches only the workspaces that team serves', () => {
    const lead = actor({
      teamIds: [POD],
      workspacesByTeam: new Map([[POD, [WS_A]]]),
      accessibleWorkspaceIds: [WS_A, WS_B],
      assignments: [{ roleId: 'team_lead', permissions: ['crm.deal:update'], teamId: POD }],
    });
    expect(decide(lead, 'crm.deal:update', { type: 'd', id: '1', workspaceId: WS_A }).allowed).toBe(
      true,
    );
    // WS_B is in the accessible set through some OTHER route, but not through this team,
    // so this assignment must not authorise it.
    expect(decide(lead, 'crm.deal:update', { type: 'd', id: '2', workspaceId: WS_B }).allowed).toBe(
      false,
    );
  });

  it('an expired role assignment grants nothing', () => {
    const a = actor({
      assignments: [
        {
          roleId: 'editor',
          permissions: ['crm.deal:update'],
          workspaceId: WS_A,
          expiresAt: new Date('2020-01-01T00:00:00Z'),
        },
      ],
    });
    const d = decide(a, 'crm.deal:update', { type: 'd', id: '1', workspaceId: WS_A });
    expect(d.allowed).toBe(false);
  });
});

describe('resource grants', () => {
  const shared = {
    resourceType: 'report',
    resourceId: 'r-1',
    permission: 'analytics.report:read',
  } as const;

  it('grant access to one specific resource without any role', () => {
    const a = actor({ resourceGrants: [shared] });
    expect(
      grantSource(
        decide(a, 'analytics.report:read', { type: 'report', id: 'r-1', workspaceId: WS_A }),
      ),
    ).toBe('resource_grant');
  });

  it('do not extend to a sibling resource', () => {
    const a = actor({ resourceGrants: [shared] });
    expect(
      decide(a, 'analytics.report:read', { type: 'report', id: 'r-2', workspaceId: WS_A }).allowed,
    ).toBe(false);
  });

  it('do not extend to another permission on the same resource', () => {
    const a = actor({ resourceGrants: [shared] });
    expect(
      decide(a, 'analytics.export:create', { type: 'report', id: 'r-1', workspaceId: WS_A })
        .allowed,
    ).toBe(false);
  });

  it('revocation takes effect immediately — an expired grant is already gone', () => {
    const a = actor({
      resourceGrants: [{ ...shared, expiresAt: new Date('2020-01-01T00:00:00Z') }],
    });
    expect(
      decide(a, 'analytics.report:read', { type: 'report', id: 'r-1', workspaceId: WS_A }).allowed,
    ).toBe(false);
  });

  it('cannot reach a workspace outside the accessible set, grant or no grant', () => {
    const a = actor({ resourceGrants: [shared], accessibleWorkspaceIds: [WS_A] });
    expect(
      denialReason(
        decide(a, 'analytics.report:read', { type: 'report', id: 'r-1', workspaceId: WS_B }),
      ),
    ).toBe('workspace_not_accessible');
  });
});

describe('ownership rules', () => {
  it('apply to a resource the actor owns', () => {
    const a = actor({ assignments: [editorIn(WS_B)] });
    const d = decide(a, 'crm.deal:update', {
      type: 'deal',
      id: 'mine',
      workspaceId: WS_A,
      ownedByActor: true,
    });
    expect(d).toEqual({ allowed: true, via: 'ownership' });
  });

  it("do not apply to another person's resource", () => {
    const a = actor({ assignments: [editorIn(WS_B)] });
    expect(
      decide(a, 'crm.deal:update', { type: 'deal', id: 'theirs', workspaceId: WS_A }).allowed,
    ).toBe(false);
  });

  it('never grant a sensitive permission — owning a connection is not reading its secret', () => {
    const a = actor({
      assignments: [
        { roleId: 'x', permissions: ['integrations.credential:read'], workspaceId: WS_B },
      ],
    });
    expect(
      decide(a, 'integrations.credential:read', {
        type: 'connection',
        id: 'c1',
        workspaceId: WS_A,
        ownedByActor: true,
      }).allowed,
    ).toBe(false);
  });
});

describe('impersonation is constrained, not a master key', () => {
  const support = (permissions: readonly string[]) =>
    actor({
      impersonated: true,
      assignments: [{ roleId: 'owner', permissions: permissions as never }],
    });

  it('permits ordinary product work', () => {
    const a = support(['social.post:read']);
    expect(decide(a, 'social.post:read', { type: 'p', id: '1', workspaceId: WS_A }).allowed).toBe(
      true,
    );
  });

  it('denies reading integration credentials', () => {
    const a = support(['integrations.credential:read']);
    expect(
      denialReason(
        decide(a, 'integrations.credential:read', { type: 'c', id: '1', workspaceId: WS_A }),
      ),
    ).toBe('impersonation_denied');
  });

  it('denies every billing mutation and API key path', () => {
    for (const p of [
      'billing.subscription:manage',
      'billing.payment_method:manage',
      'organization.api_key:create',
      'organization.api_key:read',
      'marketplace.payout:read',
    ] as const) {
      expect(denialReason(decide(support([p]), p)), p).toBe('impersonation_denied');
    }
  });
});

describe('API keys carry scopes, not just the underlying permission', () => {
  const key = (scopes: readonly string[], workspaceId?: string) =>
    actor({
      kind: 'api_key',
      apiKeyId: 'k1',
      userId: undefined,
      organizationMemberId: undefined,
      apiKeyScopes: scopes,
      accessibleWorkspaceIds: [WS_A],
      ...(workspaceId === undefined ? {} : { apiKeyWorkspaceId: workspaceId }),
      assignments: [{ roleId: 'owner', permissions: ['social.post:read', 'crm.deal:read'] }],
    });

  it('denies a permission the key is not scoped for, even when the role grants it', () => {
    expect(
      denialReason(
        decide(key(['social']), 'crm.deal:read', { type: 'd', id: '1', workspaceId: WS_A }),
      ),
    ).toBe('api_key_scope');
  });

  it('accepts a module-level scope', () => {
    expect(
      decide(key(['social']), 'social.post:read', { type: 'p', id: '1', workspaceId: WS_A })
        .allowed,
    ).toBe(true);
  });

  it('accepts an exact permission scope', () => {
    expect(
      decide(key(['crm.deal:read']), 'crm.deal:read', { type: 'd', id: '1', workspaceId: WS_A })
        .allowed,
    ).toBe(true);
  });

  it('a key narrowed to one workspace cannot act in another', () => {
    const k = key(['social'], WS_A);
    expect(
      denialReason(decide(k, 'social.post:read', { type: 'p', id: '1', workspaceId: WS_B })),
    ).toBe('workspace_not_accessible');
  });
});

/**
 * The denial reason must never reach the caller. `toProblemDetails` serialises an error's
 * `meta` into the 4xx body, so a reason carried there would let a caller map the tenant's
 * role model one probe at a time.
 */
describe('a denial does not disclose why', () => {
  it('throws ForbiddenError', () => {
    expect(() => assertPermission(actor(), 'crm.deal:read')).toThrow(ForbiddenError);
  });

  it('the serialised problem+json carries no permission, reason or role detail', () => {
    let problem: Record<string, unknown> = {};
    try {
      assertPermission(actor(), 'integrations.credential:read', {
        type: 'connection',
        id: 'c-1',
      });
    } catch (error) {
      problem = toProblemDetails(error, 'req-1') as unknown as Record<string, unknown>;
    }
    const body = JSON.stringify(problem);
    expect(body).not.toContain('integrations.credential:read');
    expect(body).not.toContain('no_grant');
    expect(body).not.toContain('connection');
    expect(problem['status']).toBe(403);
  });

  it('but the reason IS available server-side for logs and traces', () => {
    try {
      assertPermission(actor(), 'crm.deal:read');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).cause).toMatchObject({
        permission: 'crm.deal:read',
        reason: 'no_grant',
      });
    }
  });
});
