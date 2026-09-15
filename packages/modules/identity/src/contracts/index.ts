/**
 * @growth-os/module-identity/contracts
 *
 * The module's public surface. Apps import only this (enforced by the
 * `apps-import-contracts-only` boundary rule), so what appears here is what the rest of the
 * system is allowed to depend on.
 *
 * Note what is deliberately ABSENT: no password hash, no token, no token hash, no MFA
 * secret. A type that cannot express a credential cannot accidentally serialise one.
 */
export type { UserStatus } from '../domain/index.js';

/** A user as any other module may see them. */
export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly status: UserStatusView;
  readonly mfaEnabled: boolean;
  readonly emailVerified: boolean;
}

export type UserStatusView = 'pending_verification' | 'active' | 'suspended' | 'deactivated';

/** A session as shown in the device list. Carries no token and no hash. */
export interface PublicSession {
  readonly id: string;
  readonly deviceLabel: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly lastUsedAt: Date;
  readonly createdAt: Date;
  readonly current: boolean;
}

/** Permission literals this module owns, re-exported from the catalogue. */
export const IDENTITY_PERMISSIONS = [
  'organization.member:read',
  'organization.member:invite',
  'organization.member:update',
  'organization.member:remove',
] as const;
