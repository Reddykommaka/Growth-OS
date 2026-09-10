/**
 * Branded identifier types.
 *
 * A plain `string` id lets a WorkspaceId be passed where an OrganizationId is required —
 * a mistake that type-checks, compiles, and in a multi-tenant system reads or writes the
 * wrong tenant's data. Branding makes that a compile error.
 *
 * Ids are UUID v7: time-ordered for index locality, non-enumerable so they cannot leak
 * tenant volume or invite IDOR (05-data-architecture.md §1).
 */
import { z } from 'zod';

declare const brand: unique symbol;

export type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand };

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Any UUID version — for ids minted by an external system. */
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}

/**
 * Builds a branded id type plus its runtime validator and constructor.
 *
 * The constructor validates. There is deliberately no unchecked cast helper: an id that
 * enters the system unvalidated is how malformed identifiers reach a query.
 */
function defineId<TBrand extends string>(name: TBrand) {
  type Id = Brand<string, TBrand>;

  const schema = z
    .string()
    .refine((v) => UUID_ANY.test(v), { message: `Invalid ${name}: expected a UUID` })
    .transform((v) => v.toLowerCase() as Id);

  return {
    schema: schema as unknown as z.ZodType<Id>,
    /** Parses and brands. Throws `ZodError` when the value is not a UUID. */
    parse: (value: string): Id => schema.parse(value),
    is: (value: unknown): value is Id => typeof value === 'string' && UUID_ANY.test(value),
    typeName: name,
  } as const;
}

export const OrganizationId = defineId('OrganizationId');
export const TeamId = defineId('TeamId');
export const WorkspaceId = defineId('WorkspaceId');
export const UserId = defineId('UserId');
export const SessionId = defineId('SessionId');
export const RoleId = defineId('RoleId');
export const ApiKeyId = defineId('ApiKeyId');
export const ConnectionId = defineId('ConnectionId');
export const CampaignId = defineId('CampaignId');
export const ContentItemId = defineId('ContentItemId');
export const ListingId = defineId('ListingId');
export const OrderId = defineId('OrderId');
export const RequestId = defineId('RequestId');
export const JobId = defineId('JobId');
export const EventId = defineId('EventId');

export type OrganizationId = z.infer<typeof OrganizationId.schema>;
export type TeamId = z.infer<typeof TeamId.schema>;
export type WorkspaceId = z.infer<typeof WorkspaceId.schema>;
export type UserId = z.infer<typeof UserId.schema>;
export type SessionId = z.infer<typeof SessionId.schema>;
export type RoleId = z.infer<typeof RoleId.schema>;
export type ApiKeyId = z.infer<typeof ApiKeyId.schema>;
export type ConnectionId = z.infer<typeof ConnectionId.schema>;
export type CampaignId = z.infer<typeof CampaignId.schema>;
export type ContentItemId = z.infer<typeof ContentItemId.schema>;
export type ListingId = z.infer<typeof ListingId.schema>;
export type OrderId = z.infer<typeof OrderId.schema>;
export type RequestId = z.infer<typeof RequestId.schema>;
export type JobId = z.infer<typeof JobId.schema>;
export type EventId = z.infer<typeof EventId.schema>;
