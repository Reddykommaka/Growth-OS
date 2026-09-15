/**
 * Invitation rules.
 *
 * The escalation check is the one that matters: without it, `organization.member:invite` is
 * a silent route to `owner`.
 */
import type { Permission } from '@growth-os/authz';
import { SYSTEM_ROLES } from '@growth-os/authz';
import { describe, expect, it } from 'vitest';
import {
  addressMatchesInvitation,
  checkNoEscalation,
  INVITATION_TTL_MS,
  invitationState,
  memberTypeForRole,
  scopeMatchesRole,
} from './invitations.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const perms = (...p: string[]) => p as Permission[];

describe('privilege escalation', () => {
  it('permits granting a role you fully hold', () => {
    expect(checkNoEscalation(perms('a.b:read', 'a.b:write'), perms('a.b:read'))).toEqual({
      allowed: true,
    });
  });

  it('permits granting exactly your own permissions', () => {
    const held = perms('a.b:read', 'a.b:write');
    expect(checkNoEscalation(held, held).allowed).toBe(true);
  });

  it('REFUSES granting a permission you lack, and names what is missing', () => {
    const verdict = checkNoEscalation(perms('a.b:read'), perms('a.b:read', 'a.b:delete'));
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.missing).toEqual(['a.b:delete']);
  });

  it('refuses an empty inviter granting anything', () => {
    expect(checkNoEscalation([], perms('a.b:read')).allowed).toBe(false);
  });

  it('permits granting nothing, even from nothing', () => {
    expect(checkNoEscalation([], []).allowed).toBe(true);
  });

  /**
   * The concrete attack, against the REAL role definitions: an admin must not be able to
   * invite someone as owner. Set containment rather than role ranking is what makes this
   * hold without a second model that can drift.
   */
  it('an admin cannot grant owner', () => {
    const admin = SYSTEM_ROLES.find((r) => r.slug === 'admin');
    const owner = SYSTEM_ROLES.find((r) => r.slug === 'owner');
    if (admin === undefined || owner === undefined) throw new Error('roles missing');
    expect(checkNoEscalation(admin.permissions, owner.permissions).allowed).toBe(false);
  });

  it('an owner can grant admin', () => {
    const admin = SYSTEM_ROLES.find((r) => r.slug === 'admin');
    const owner = SYSTEM_ROLES.find((r) => r.slug === 'owner');
    if (admin === undefined || owner === undefined) throw new Error('roles missing');
    expect(checkNoEscalation(owner.permissions, admin.permissions).allowed).toBe(true);
  });

  it('a workspace editor cannot grant workspace_admin', () => {
    const editor = SYSTEM_ROLES.find((r) => r.slug === 'editor');
    const wsAdmin = SYSTEM_ROLES.find((r) => r.slug === 'workspace_admin');
    if (editor === undefined || wsAdmin === undefined) throw new Error('roles missing');
    expect(checkNoEscalation(editor.permissions, wsAdmin.permissions).allowed).toBe(false);
  });

  it('client_guest can be granted by any role that holds its permissions', () => {
    const guest = SYSTEM_ROLES.find((r) => r.slug === 'client_guest');
    const owner = SYSTEM_ROLES.find((r) => r.slug === 'owner');
    if (guest === undefined || owner === undefined) throw new Error('roles missing');
    expect(checkNoEscalation(owner.permissions, guest.permissions).allowed).toBe(true);
  });

  /** No role may grant a strict superset of itself — the property, checked across all. */
  it('no system role can grant a role it does not contain', () => {
    for (const granter of SYSTEM_ROLES) {
      for (const granted of SYSTEM_ROLES) {
        const held = new Set<string>(granter.permissions);
        const contains = granted.permissions.every((p) => held.has(p));
        expect(
          checkNoEscalation(granter.permissions, granted.permissions).allowed,
          `${granter.slug} → ${granted.slug}`,
        ).toBe(contains);
      }
    }
  });
});

describe('invitation state', () => {
  const base = { expiresAt: new Date(NOW.getTime() + 1000), acceptedAt: null, revokedAt: null };

  it('is pending while live', () => {
    expect(invitationState(base, NOW)).toBe('pending');
  });

  /** Revocation beats everything: withdrawn is withdrawn, not merely "expired". */
  it('reports revoked even when also expired and accepted', () => {
    expect(
      invitationState(
        { expiresAt: new Date(NOW.getTime() - 1), acceptedAt: NOW, revokedAt: NOW },
        NOW,
      ),
    ).toBe('revoked');
  });

  it('reports accepted before expired', () => {
    expect(
      invitationState(
        { expiresAt: new Date(NOW.getTime() - 1), acceptedAt: NOW, revokedAt: null },
        NOW,
      ),
    ).toBe('accepted');
  });

  it('reports expired at the boundary', () => {
    expect(invitationState({ ...base, expiresAt: NOW }, NOW)).toBe('expired');
  });

  it('lives for seven days', () => {
    expect(INVITATION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('the accepter must be the invitee', () => {
  it.each([
    ['ada@example.test', 'ada@example.test'],
    ['Ada@Example.test', 'ada@example.TEST'],
    ['ada@example.test', '  ada@example.test  '],
  ])('matches %s against %s', (invited, accepter) => {
    expect(addressMatchesInvitation(invited, accepter)).toBe(true);
  });

  /** A forwarded link must not be an access grant to whoever opens it. */
  it.each([
    ['ada@example.test', 'eve@example.test'],
    ['ada@example.test', 'ada@evil.test'],
    ['ada@example.test', 'ada+tag@example.test'],
  ])('refuses %s against %s', (invited, accepter) => {
    expect(addressMatchesInvitation(invited, accepter)).toBe(false);
  });
});

describe('role scope and member type', () => {
  it('matches each scope to its role scope', () => {
    expect(scopeMatchesRole('organization', { kind: 'organization' })).toBe(true);
    expect(scopeMatchesRole('workspace', { kind: 'workspace', workspaceId: 'w' })).toBe(true);
    expect(scopeMatchesRole('team', { kind: 'team', teamId: 't' })).toBe(true);
  });

  /**
   * A role granted at the wrong scope produces an assignment the engine never matches — it
   * looks like access was granted and grants nothing, which is worse than an error.
   */
  it('refuses a mismatched scope', () => {
    expect(scopeMatchesRole('organization', { kind: 'workspace', workspaceId: 'w' })).toBe(false);
    expect(scopeMatchesRole('workspace', { kind: 'organization' })).toBe(false);
    expect(scopeMatchesRole('team', { kind: 'workspace', workspaceId: 'w' })).toBe(false);
  });

  it('makes client_guest a client membership and everything else staff', () => {
    expect(memberTypeForRole('client_guest')).toBe('client');
    for (const role of SYSTEM_ROLES.filter((r) => r.slug !== 'client_guest')) {
      expect(memberTypeForRole(role.slug), role.slug).toBe('staff');
    }
  });
});
