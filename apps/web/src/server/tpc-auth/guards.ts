import { ROLE_RANK, TpcAuthError, type AuthContext, type OrgClaim, type Role } from "./types.js";

/**
 * Assert the token was minted for this app. A token for another app never
 * verifies here anyway (wrong `aud`), so this is the belt to that suspenders:
 * it catches an IdP-audience token being replayed at an app endpoint.
 */
export function requireApp(ctx: AuthContext, appId: string): AuthContext {
  if (ctx.app !== appId) {
    throw new TpcAuthError(`token is not bound to app "${appId}"`, "insufficient_scope", 403);
  }
  return ctx;
}

/** The person's role in one org, or null if they are not a member. */
export function orgRole(ctx: AuthContext, orgId: string): Role | null {
  const org = ctx.orgs.find((o: OrgClaim) => o.id === orgId || o.slug === orgId);
  return org ? org.role : null;
}

/**
 * Assert membership of `orgId` at `minRole` or above.
 * Roles are ordered viewer < member < manager < admin < owner.
 */
export function requireOrgRole(ctx: AuthContext, orgId: string, minRole: Role): AuthContext {
  const role = orgRole(ctx, orgId);
  if (!role) throw new TpcAuthError("not a member of this organization", "insufficient_scope", 403);
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw new TpcAuthError(`role "${role}" is below required "${minRole}"`, "insufficient_scope", 403);
  }
  return ctx;
}

/** Assert a scope is present on the token. */
export function requireScope(ctx: AuthContext, scope: string): AuthContext {
  if (!ctx.scopes.includes(scope)) {
    throw new TpcAuthError(`missing scope "${scope}"`, "insufficient_scope", 403);
  }
  return ctx;
}
