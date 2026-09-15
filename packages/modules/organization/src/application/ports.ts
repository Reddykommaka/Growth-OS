/**
 * Ports for the organization services.
 *
 * `pg` is banned from application/, so persistence arrives as an interface. The payoff is
 * that the escalation and lifecycle rules are testable without a database, while the parts
 * that genuinely need one — uniqueness, single-use tokens, concurrent acceptance — are
 * tested against a real cluster.
 */
import type { Permission } from '@growth-os/authz';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface AuditEvent {
  readonly action: string;
  readonly actorUserId: string | null;
  readonly organizationId?: string | undefined;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly ip?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

export interface RateLimiter {
  consume(key: string): Promise<boolean>;
  reset(key: string): Promise<void>;
}

export interface RoleRecord {
  readonly id: string;
  readonly slug: string;
  readonly scope: string;
  readonly permissions: readonly Permission[];
}

export interface OrganizationReader {
  /** The organization's display name, for the invitation a stranger will receive. */
  nameOf(organizationId: string): Promise<string | undefined>;
}

export interface RoleReader {
  /** A system role, or a custom role belonging to this organization. Never another's. */
  findAssignableRole(organizationId: string, slug: string): Promise<RoleRecord | undefined>;
  findById(roleId: string): Promise<RoleRecord | undefined>;
}

export interface InvitationRow {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly roleId: string;
  readonly teamId: string | null;
  readonly workspaceId: string | null;
  readonly memberType: 'staff' | 'client';
  readonly invitedBy: string | null;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface InvitationRepository {
  create(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly email: string;
    readonly roleId: string;
    readonly teamId?: string | undefined;
    readonly workspaceId?: string | undefined;
    readonly memberType: 'staff' | 'client';
    readonly tokenHash: Buffer;
    readonly invitedBy: string | null;
    readonly expiresAt: Date;
  }): Promise<void>;

  /**
   * Finds an invitation by token hash WITHIN the organization scope already open.
   *
   * The scope comes from the routing hint the token carries, so the RLS policy is what
   * decides whether this row belongs to the tenant being named — a token pointed at
   * another organization finds nothing here (ADR-0018).
   */
  findByTokenHash(tokenHash: Buffer): Promise<InvitationRow | undefined>;
  findById(organizationId: string, id: string): Promise<InvitationRow | undefined>;
  findPending(organizationId: string, email: string): Promise<InvitationRow | undefined>;

  /** Marks accepted, returning false if it already was. Single-use, settled by the write. */
  consume(id: string, at: Date): Promise<boolean>;
  revoke(organizationId: string, id: string, at: Date): Promise<boolean>;
  rotateToken(id: string, tokenHash: Buffer, expiresAt: Date, at: Date): Promise<void>;
  listPending(organizationId: string): Promise<InvitationRow[]>;
}

export interface AdmitInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly memberType: 'staff' | 'client';
  readonly roleId: string;
  readonly teamId: string | null;
  readonly workspaceId: string | null;
  readonly invitedBy: string | null;
  readonly at: Date;
}

export interface MembershipWriter {
  isMember(organizationId: string, userId: string): Promise<boolean>;
  /**
   * Creates the membership AND its role assignment, atomically.
   *
   * One operation because the halves are useless apart: a member with no assignment has
   * joined an organization they cannot see, and repairing it needs database access.
   */
  admit(input: AdmitInput): Promise<string>;
}

export interface ApiKeyRow {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly prefix: string;
  readonly keyHash: string;
  readonly scopes: readonly Permission[];
  readonly workspaceId: string | null;
  readonly createdBy: string | null;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface ApiKeyRepository {
  create(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly name: string;
    readonly prefix: string;
    readonly keyHash: string;
    readonly scopes: readonly Permission[];
    readonly workspaceId: string | null;
    readonly createdBy: string | null;
    readonly expiresAt: Date | null;
  }): Promise<void>;

  /**
   * Looks a key up by its PUBLIC prefix, within the organization scope already open.
   *
   * Deliberately not by the secret: the prefix is uniquely indexed, so this is one index
   * probe, and the secret is then verified with Argon2 against the row. Searching by secret
   * would mean hashing against every row.
   */
  findByPrefix(prefix: string): Promise<ApiKeyRow | undefined>;
  findById(organizationId: string, id: string): Promise<ApiKeyRow | undefined>;
  listForOrganization(organizationId: string): Promise<Omit<ApiKeyRow, 'keyHash'>[]>;
  revoke(organizationId: string, id: string, at: Date): Promise<boolean>;
  touch(id: string, at: Date): Promise<void>;
}

/**
 * What an invitation email must carry.
 *
 * A CONTRACT, not a mailer. The token appears in exactly one place in this system — here,
 * on its way to the one address that was invited — and the shape is declared so that the
 * notification module implementing it later cannot decide for itself what an invitation
 * link needs, and so that this service never builds a URL or a subject line, which are
 * presentation concerns belonging to whatever renders them.
 *
 * Deliberately NOT a rendered message: no subject, no body, no HTML. A service that formats
 * an email is a service that will eventually format the token into a log line.
 */
export interface InvitationDelivery {
  readonly invitationId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  /** The invited address. The ONLY address this may be delivered to. */
  readonly email: string;
  /** The single-use token. Must reach the recipient and nothing else — never a log. */
  readonly token: string;
  readonly roleSlug: string;
  readonly invitedByUserId: string | null;
  readonly expiresAt: Date;
  /** Whether this is a resend, so the recipient can be told the previous link is dead. */
  readonly resent: boolean;
}

/**
 * Delivers an invitation.
 *
 * Optional on the service: an invitation created by a migration or a back-office tool has
 * nobody to mail. When supplied, a delivery FAILURE fails the whole operation — the
 * invitation is created inside the caller's transaction, so nothing is left behind, and the
 * inviter sees an error instead of believing a message was sent that was not.
 *
 * The production implementation will enqueue through the transactional outbox (ADR-0007)
 * rather than send inline, which is why this returns void rather than a delivery receipt.
 */
export interface InvitationNotifier {
  deliver(delivery: InvitationDelivery): Promise<void>;
}

export interface WorkspaceTopologyReader {
  allWorkspaceIds(organizationId: string): Promise<string[]>;
}

/**
 * The repositories a credential-resolution transaction needs.
 *
 * Bundled rather than passed one by one because they must all read the SAME transaction:
 * acceptance reads the invitation, consumes it and writes the membership, and a repository
 * built over a different connection would put those steps in different transactions — where
 * a crash between them leaves a consumed invitation and no member.
 */
export interface TenantScopedRepositories {
  readonly invitations: InvitationRepository;
  readonly roles: RoleReader;
  readonly memberships: MembershipWriter;
  readonly apiKeys: ApiKeyRepository;
  readonly topology: WorkspaceTopologyReader;
}

/**
 * Opens a unit of work for ONE organization, named by a credential's routing hint.
 *
 * The hint is untrusted. Everything read inside is still filtered by the RLS policy against
 * that organization, so naming the wrong one finds nothing rather than finding somebody
 * else's row. See ADR-0018 and `withOrganizationScope`.
 *
 * TWO METHODS, because they claim different things, and which one a call site uses is the
 * whole of what it is permitted to see. It is a method rather than a parameter so that the
 * claim cannot be forwarded from somewhere else: a grep for the second name lists every
 * place in the system that asks for organization-wide reach.
 */
export interface TenantScopeFactory {
  /**
   * No workspace reach AT ALL: the set is empty and the scope is 'set', so every
   * workspace-scoped table returns nothing.
   *
   * For resolving a credential that grants no workspace access of its own — an invitation,
   * which reads one row keyed by a token hash and writes organization-scoped membership.
   */
  withoutWorkspaceReach<T>(
    organizationId: string,
    reason: string,
    body: (repositories: TenantScopedRepositories) => Promise<T>,
  ): Promise<T>;

  /**
   * Organization-wide reach across workspace TOPOLOGY, within this one organization.
   *
   * For the callers that must COMPUTE an accessible-workspace set and therefore cannot run
   * under a policy that demands one — the same bootstrap problem migration 0007 describes.
   * API-key authentication is one: an un-narrowed key spans its organization, and the
   * authorization engine checks reachability against a materialised list, so the list has to
   * be read before the actor exists.
   *
   * Narrow by construction: it reads workspace ids, and the actor it produces is still
   * checked by the same engine and the same policies as any other.
   */
  withOrganizationWideWorkspaceReach<T>(
    organizationId: string,
    reason: string,
    body: (repositories: TenantScopedRepositories) => Promise<T>,
  ): Promise<T>;
}
