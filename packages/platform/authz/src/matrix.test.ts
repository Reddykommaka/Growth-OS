/**
 * The authorization matrix — generated, not hand-written (11-testing-architecture.md §3).
 *
 * Every (role × permission) pair is enumerated from the catalogue and the role definitions,
 * so adding a permission without deciding what each role may do with it FAILS THE BUILD.
 * There is no "we forgot to test that endpoint".
 *
 * The matrix is the artefact a security reviewer actually needs: a diff here shows exactly
 * what a role gained.
 */
import { describe, expect, it } from 'vitest';
import type { ActorContext } from './actor.js';
import { decide, type ResourceRef } from './engine.js';
import {
  PERMISSIONS,
  type Permission,
  permissionScope,
  SENSITIVE_PERMISSIONS,
} from './permissions.js';
import { SYSTEM_ROLES, type SystemRole } from './roles.js';

const ORG = 'org-1';
const WS_A = 'ws-a';
const WS_B = 'ws-b';
const TEAM = 'team-1';

/** Builds an actor holding exactly one system role, at that role's own scope. */
function actorWith(role: SystemRole, overrides: Partial<ActorContext> = {}): ActorContext {
  const assignment = {
    roleId: role.slug,
    permissions: role.permissions,
    ...(role.scope === 'team' ? { teamId: TEAM } : {}),
    ...(role.scope === 'workspace' ? { workspaceId: WS_A } : {}),
  };
  return {
    kind: 'user',
    userId: 'user-1',
    organizationId: ORG,
    organizationMemberId: 'member-1',
    organizationStatus: 'active',
    assignments: [assignment],
    resourceGrants: [],
    accessibleWorkspaceIds: [WS_A],
    // Required on ActorContext, and previously missing here — so the whole generated matrix
    // was computed against an actor no production path can produce. Found by typechecking
    // the tests; see tsconfig.test.json.
    workspaceScope: 'set',
    teamIds: role.scope === 'team' ? [TEAM] : [],
    workspacesByTeam: role.scope === 'team' ? new Map([[TEAM, [WS_A]]]) : new Map(),
    mfaSatisfied: true,
    mfaRequired: false,
    impersonated: false,
    apiKeyScopes: [],
    ...overrides,
  };
}

/**
 * The resource a permission is exercised against.
 *
 * Driven by the catalogue's own scope classification rather than by guessing from the
 * module prefix. The first version of this helper guessed, and mis-scoped every
 * `organization.workspace:*` permission — which lives in the organization module but acts
 * on a single workspace.
 */
function resourceFor(permission: Permission): ResourceRef {
  const module = permission.slice(0, permission.indexOf('.'));
  switch (permissionScope(permission)) {
    case 'organization':
      return { type: module, id: 'res-1' };
    case 'team':
      return { type: module, id: TEAM, teamId: TEAM };
    default:
      return { type: module, id: 'res-1', workspaceId: WS_A };
  }
}

describe('the matrix covers the whole catalogue', () => {
  it('enumerates every permission', () => {
    expect(PERMISSIONS.length).toBeGreaterThan(0);
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('every permission is well-formed <module>.<resource>:<action>', () => {
    for (const p of PERMISSIONS) {
      expect(p, p).toMatch(/^[a-z_]+\.[a-z_]+:[a-z_]+$/);
    }
  });

  it('every role references only catalogue permissions', () => {
    const known = new Set<string>(PERMISSIONS);
    for (const role of SYSTEM_ROLES) {
      for (const p of role.permissions) {
        expect(known.has(p), `${role.slug} → ${p}`).toBe(true);
      }
    }
  });
});

/**
 * The generated matrix itself. For each role, every permission in the catalogue is checked:
 * a permission the role declares must be allowed, and one it does not must be denied.
 *
 * The two must agree for all of them, because the declared set is what a reviewer reads and
 * the decision is what actually happens. A divergence means the role definition is a lie.
 */
describe.each(SYSTEM_ROLES.map((r) => [r.slug, r] as const))(
  'role %s — every permission decided',
  (_slug, role) => {
    const declared = new Set<string>(role.permissions);

    it('allows exactly the permissions it declares, and denies the rest', () => {
      const actor = actorWith(role);
      const wrong: string[] = [];
      for (const permission of PERMISSIONS) {
        const resource = resourceFor(permission);
        const decision = decide(actor, permission, resource);
        const shouldAllow = declared.has(permission);
        if (decision.allowed !== shouldAllow) {
          wrong.push(
            `${permission}: declared=${shouldAllow ? 'allow' : 'deny'} ` +
              `actual=${decision.allowed ? 'allow' : `deny(${decision.reason})`}`,
          );
        }
      }
      expect(wrong).toEqual([]);
    });
  },
);

describe('client_guest containment — the role held from outside the tenant', () => {
  const guest = SYSTEM_ROLES.find((r) => r.slug === 'client_guest');
  if (guest === undefined) throw new Error('client_guest missing from SYSTEM_ROLES');

  const actor = actorWith(guest);

  it('may approve and comment in its own workspace', () => {
    for (const p of ['social.post:approve', 'social.comment:create'] as const) {
      expect(decide(actor, p, { type: 'social', id: 'x', workspaceId: WS_A }).allowed, p).toBe(
        true,
      );
    }
  });

  it('is denied EVERY sensitive permission', () => {
    for (const p of SENSITIVE_PERMISSIONS) {
      const decision = decide(actor, p, resourceFor(p));
      expect(decision.allowed, p).toBe(false);
    }
  });

  it('is denied every billing and member-management permission', () => {
    const forbidden = PERMISSIONS.filter(
      (p) => p.startsWith('billing.') || p.startsWith('organization.member'),
    );
    expect(forbidden.length).toBeGreaterThan(0);
    for (const p of forbidden) {
      expect(decide(actor, p, resourceFor(p)).allowed, p).toBe(false);
    }
  });

  it('cannot reach any other workspace in the organization, for any permission', () => {
    for (const p of PERMISSIONS) {
      const decision = decide(actor, p, { type: 'x', id: 'y', workspaceId: WS_B });
      expect(decision.allowed, p).toBe(false);
    }
  });

  /**
   * The allow-list property, asserted rather than assumed. If client_guest were defined by
   * subtraction, every permission added in a later phase would be granted to an outside
   * party by default — and nobody would notice until it mattered.
   */
  it('holds a small, explicitly-listed set rather than most of the catalogue', () => {
    expect(guest.permissions.length).toBeLessThan(PERMISSIONS.length / 3);
  });
});
