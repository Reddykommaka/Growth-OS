/**
 * Three-scope resolution and the accessible-workspace set (11-testing-architecture.md §3).
 *
 * This is the computation the two-level RLS predicate depends on: if the set is wrong, the
 * database enforces the wrong boundary perfectly.
 */
import { describe, expect, it } from 'vitest';
import { resolveAccessibleWorkspaces, toPostgresArrayLiteral } from './workspace-set.js';

const WS1 = 'ws-1';
const WS2 = 'ws-2';
const WS3 = 'ws-3';
const WS4 = 'ws-4';
const POD_A = 'team-pod-a';
const POD_B = 'team-pod-b';

const base = {
  directWorkspaceIds: [],
  teamIds: [],
  workspacesOwnedByTeam: new Map<string, readonly string[]>(),
  workspacesGrantedToTeam: new Map<string, readonly string[]>(),
  allOrganizationWorkspaceIds: [WS1, WS2, WS3, WS4],
  hasOrganizationScopedRole: false,
} as const;

describe('accessible-workspace set', () => {
  it('an organization-scoped role reaches every workspace in the tenant', () => {
    const r = resolveAccessibleWorkspaces({ ...base, hasOrganizationScopedRole: true });
    expect(r.workspaceIds).toEqual([WS1, WS2, WS3, WS4]);
  });

  it('a direct workspace assignment reaches exactly that workspace', () => {
    const r = resolveAccessibleWorkspaces({ ...base, directWorkspaceIds: [WS2] });
    expect(r.workspaceIds).toEqual([WS2]);
  });

  /**
   * The property that makes agency access maintainable: a pod lead reaches the clients
   * their pod serves, INCLUDING ones added to the pod next month, without a new grant.
   */
  it('team membership reaches every workspace the team owns', () => {
    const r = resolveAccessibleWorkspaces({
      ...base,
      teamIds: [POD_A],
      workspacesOwnedByTeam: new Map([[POD_A, [WS1, WS2]]]),
    });
    expect(r.workspaceIds).toEqual([WS1, WS2]);
  });

  it('team_workspace_access adds a specialist pod without moving the workspace', () => {
    const r = resolveAccessibleWorkspaces({
      ...base,
      teamIds: [POD_B],
      workspacesOwnedByTeam: new Map([[POD_B, [WS3]]]),
      workspacesGrantedToTeam: new Map([[POD_B, [WS1]]]),
    });
    // WS1 is owned by another pod; this pod reaches it only through the grant.
    expect(r.workspaceIds).toEqual([WS1, WS3]);
  });

  it('unions owned and granted without duplicating an overlap', () => {
    const r = resolveAccessibleWorkspaces({
      ...base,
      teamIds: [POD_A],
      workspacesOwnedByTeam: new Map([[POD_A, [WS1, WS2]]]),
      workspacesGrantedToTeam: new Map([[POD_A, [WS2, WS3]]]),
    });
    expect(r.workspaceIds).toEqual([WS1, WS2, WS3]);
    expect(new Set(r.workspaceIds).size).toBe(r.workspaceIds.length);
  });

  /**
   * A workspace moved between teams. The set must follow the move immediately — this is the
   * event that invalidates every cached workspace set in the organization (06 §5).
   */
  it('follows a workspace moved from one pod to another', () => {
    const before = resolveAccessibleWorkspaces({
      ...base,
      teamIds: [POD_A],
      workspacesOwnedByTeam: new Map([[POD_A, [WS1, WS2]]]),
    });
    expect(before.workspaceIds).toContain(WS2);

    const after = resolveAccessibleWorkspaces({
      ...base,
      teamIds: [POD_A],
      workspacesOwnedByTeam: new Map([
        [POD_A, [WS1]],
        [POD_B, [WS2]],
      ]),
    });
    expect(after.workspaceIds).not.toContain(WS2);
  });

  it('an actor removed from a pod loses every workspace that pod reached', () => {
    const r = resolveAccessibleWorkspaces({
      ...base,
      teamIds: [],
      workspacesOwnedByTeam: new Map([[POD_A, [WS1, WS2]]]),
    });
    expect(r.workspaceIds).toEqual([]);
  });

  it('is empty for a member with no role, team or grant — fails closed', () => {
    expect(resolveAccessibleWorkspaces(base).workspaceIds).toEqual([]);
  });

  /**
   * A narrowed API key must not be widened by whatever its creator can reach. Intersection,
   * never union — an integration built for one client cannot read another.
   */
  it('a workspace-narrowed API key intersects rather than unions', () => {
    const r = resolveAccessibleWorkspaces({
      ...base,
      hasOrganizationScopedRole: true,
      restrictToWorkspaceId: WS2,
    });
    expect(r.workspaceIds).toEqual([WS2]);
  });

  it('a narrowed API key pointed at a workspace it cannot reach resolves to nothing', () => {
    const r = resolveAccessibleWorkspaces({
      ...base,
      directWorkspaceIds: [WS1],
      restrictToWorkspaceId: WS3,
    });
    expect(r.workspaceIds).toEqual([]);
  });

  /**
   * Stable ordering. The set is cached per (session, organization); an unstable order makes
   * two identical sets look like a change, and makes the value unreadable in an incident.
   */
  it('is deterministically ordered regardless of input order', () => {
    const a = resolveAccessibleWorkspaces({ ...base, directWorkspaceIds: [WS3, WS1, WS2] });
    const b = resolveAccessibleWorkspaces({ ...base, directWorkspaceIds: [WS2, WS3, WS1] });
    expect(a.workspaceIds).toEqual(b.workspaceIds);
  });
});

describe('the value handed to PostgreSQL', () => {
  it('formats as a uuid[] literal', () => {
    expect(toPostgresArrayLiteral([WS1, WS2])).toBe('{ws-1,ws-2}');
  });

  it('formats an empty set as an empty array, not NULL', () => {
    // An empty array makes `id = ANY(...)` false. NULL would make the predicate NULL, which
    // is also not true — but the empty array is the shape app_current_workspace_ids()
    // guarantees, and matching it keeps the fail-closed behaviour explicit.
    expect(toPostgresArrayLiteral([])).toBe('{}');
  });
});
