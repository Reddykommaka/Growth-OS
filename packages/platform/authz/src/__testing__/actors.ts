/**
 * Actor construction and decision narrowing for the authorization suites.
 *
 * Shared rather than duplicated because the builder encodes a real invariant: a production
 * ActorContext always carries every required field. Two copies drift, and a copy that quietly
 * omits one tests an actor no code path can produce — which is exactly what had happened to
 * `workspaceScope` in both suites before the tests were typechecked.
 */
import type { ActorContext } from '../actor.js';
import type { AuthzDecision, DenyReason, GrantSource } from '../engine.js';

/**
 * Overrides for the actor builder.
 *
 * `Partial<ActorContext>` is not quite right under `exactOptionalPropertyTypes`: it permits
 * a key to be ABSENT but not present-and-explicitly-undefined, and several cases here mean
 * exactly that — "this actor has no membership row", "this actor is not a user". Spelling
 * it out keeps the production type untouched.
 */
type ActorOverrides = { [K in keyof ActorContext]?: ActorContext[K] | undefined };

/**
 * The denial reason, or undefined when the decision was to ALLOW.
 *
 * `decide(...).reason` does not typecheck: `AuthzDecision` is a discriminated union and the
 * allowed branch carries no `reason`. These tests read it anyway, which worked at runtime
 * only because JavaScript yields `undefined` — and the assertions stayed meaningful, since
 * an unexpected allow then fails against the expected string. So the fix is to narrow, not
 * to cast: an allow still yields `undefined` and still fails the expectation.
 */
export function denialReason(decision: AuthzDecision): DenyReason | undefined {
  return decision.allowed ? undefined : decision.reason;
}

/** The grant source, or undefined when the decision was to DENY. Mirror of the above. */
export function grantSource(decision: AuthzDecision): GrantSource | undefined {
  return decision.allowed ? decision.via : undefined;
}

export const ORG = 'org-1';
export const WS_A = 'ws-a';
export const WS_B = 'ws-b';
export const POD = 'team-1';

export function actor(overrides: ActorOverrides = {}): ActorContext {
  const base: ActorContext = {
    kind: 'user',
    userId: 'user-1',
    organizationId: ORG,
    organizationMemberId: 'member-1',
    organizationStatus: 'active',
    assignments: [],
    resourceGrants: [],
    accessibleWorkspaceIds: [WS_A],
    // Required on ActorContext, and previously MISSING from this builder — so every actor
    // in this suite ran with it undefined, which no production actor ever is. Found by
    // typechecking the tests; see tsconfig.test.json.
    workspaceScope: 'set',
    teamIds: [],
    workspacesByTeam: new Map(),
    mfaSatisfied: true,
    mfaRequired: false,
    impersonated: false,
    apiKeyScopes: [],
  };

  // An override of `undefined` REMOVES the key rather than setting it. Under
  // `exactOptionalPropertyTypes` an optional field is absent or a value — never present and
  // undefined — and "this actor has no membership row" is expressed by absence. The cast is
  // confined to this loop: it is the one place a dynamic key write happens.
  const built = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete built[key];
    else built[key] = value;
  }
  return built as unknown as ActorContext;
}
