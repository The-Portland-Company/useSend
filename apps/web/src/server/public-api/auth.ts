import { Context } from "hono";
import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";
import { db } from "../db";
import { UnsendApiError } from "./api-error";
import { getTeamAndApiKey } from "../service/api-service";
import { env } from "~/env";
import { logger } from "../logger/log";

/**
 * Scopes the public API understands on a TPC-issued bearer token.
 *
 * `usesend:send` (write tier) covers a single transactional send;
 * `usesend:campaign` (danger tier) covers bulk/campaign/broadcast sends.
 * `usesend:read` covers everything else. For one release, the legacy
 * `usesend:write` scope (the one TPC Auth currently issues) still satisfies
 * `usesend:send` only — it never grants `usesend:campaign`.
 *
 * This function only does the coarse GET-vs-write gate at token-verify time.
 * The finer send-vs-campaign scope check, plus approval/lockdown/dailyCap,
 * happens in the public-api hono middleware once `tpcAuth` is on the team
 * context, because it needs the route (send vs. campaign vs. delete), not
 * just the method.
 *
 * These must be added to TPC Auth's `apps.scopes` list for the `usesend` app.
 */
export const TPC_SEND_SCOPE = "usesend:send";
export const TPC_CAMPAIGN_SCOPE = "usesend:campaign";
export const TPC_READ_SCOPE = "usesend:read";
export const TPC_LEGACY_WRITE_SCOPE = "usesend:write";

export function hasTpcScope(scopes: Set<string> | string[], required: string): boolean {
  const set = scopes instanceof Set ? scopes : new Set(scopes);
  if (set.has(required)) return true;
  if (required === TPC_SEND_SCOPE && set.has(TPC_LEGACY_WRITE_SCOPE)) return true;
  return false;
}

export function requiredScopeForRequest(c: Context): string {
  const path = c.req.path;
  const isSendRoute =
    /\/api\/v1\/emails(\/|$)/.test(path) ||
    /\/api\/v1\/campaigns(\/|$)/.test(path);

  if (c.req.method !== "GET" && isSendRoute) {
    return TPC_SEND_SCOPE;
  }

  return TPC_READ_SCOPE;
}

interface TpcTokenClaims extends JWTPayload {
  scope?: string;
  scopes?: string[];
}

// A useSend opaque API key always looks like `us_<clientId>_<token>`.
function looksLikeApiKey(token: string): boolean {
  return token.startsWith("us_");
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksIssuer: string | null = null;

function getJwks(issuer: string) {
  if (!jwks || jwksIssuer !== issuer) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    jwksIssuer = issuer;
  }
  return jwks;
}

function getTokenScopes(claims: TpcTokenClaims): Set<string> {
  const scopes = new Set<string>();

  if (typeof claims.scope === "string") {
    for (const s of claims.scope.split(" ")) {
      if (s) scopes.add(s);
    }
  }

  if (Array.isArray(claims.scopes)) {
    for (const s of claims.scopes) {
      if (typeof s === "string") scopes.add(s);
    }
  }

  return scopes;
}

/**
 * Verifies a TPC-issued JWT access token and resolves it to a useSend team,
 * the same way TPC Auth's OIDC login resolves a person to a team: `sub` ->
 * `User.tpcSub` -> that user's team (see `User.tpcSub` in schema.prisma and
 * `teamProcedure` in server/api/trpc.ts, which does the same lookup for the
 * dashboard session).
 */
async function getTeamFromTpcToken(token: string, requiredScope: string) {
  if (!env.AUTH_TPC_ISSUER || !env.AUTH_TPC_RESOURCE) {
    throw new UnsendApiError({
      code: "UNAUTHORIZED",
      message: "Invalid API token",
    });
  }

  const issuer = env.AUTH_TPC_ISSUER.replace(/\/$/, "");

  let payload: TpcTokenClaims;
  try {
    const result = await jwtVerify(token, getJwks(issuer), {
      issuer,
      audience: env.AUTH_TPC_RESOURCE,
    });
    payload = result.payload;
  } catch (err) {
    logger.warn({ err }, "TPC token verification failed");
    throw new UnsendApiError({
      code: "UNAUTHORIZED",
      message: "Invalid API token",
    });
  }

  const scopes = getTokenScopes(payload);
  if (!hasTpcScope(scopes, requiredScope)) {
    throw new UnsendApiError({
      code: "FORBIDDEN",
      message: `Token is missing required scope: ${requiredScope}`,
    });
  }

  const sub = payload.sub;
  if (!sub) {
    throw new UnsendApiError({
      code: "UNAUTHORIZED",
      message: "Invalid API token",
    });
  }

  const user = await db.user.findUnique({ where: { tpcSub: sub } });
  if (!user) {
    throw new UnsendApiError({
      code: "FORBIDDEN",
      message: "No useSend account is linked to this token",
    });
  }

  const teamUser = await db.teamUser.findFirst({
    where: { userId: user.id },
    include: { team: true },
  });

  if (!teamUser) {
    throw new UnsendApiError({
      code: "FORBIDDEN",
      message: "No useSend team is linked to this token",
    });
  }

  // `act` (RFC 8693) names who's actually driving this credential when it's
  // not the person named by `sub` — an agent PAT exchange or MCP client.
  const actClaim = (payload as Record<string, unknown>).act;
  const actorSub =
    actClaim && typeof actClaim === "object" && "sub" in actClaim
      ? String((actClaim as { sub: unknown }).sub)
      : undefined;

  return {
    ...teamUser.team,
    apiKeyId: undefined,
    apiKey: { domainId: null },
    // Minimal AuthContext-shaped view of this JWT, for the scope/approval/
    // lockdown/dailyCap middleware in hono.ts. Built from the claims this
    // app already verifies above rather than the SDK's own authenticate(),
    // since this app keeps its existing jose-based verification path.
    tpcAuth: {
      sub,
      // This app has no org claim on its own tokens today (single-team
      // membership is resolved via User.tpcSub -> TeamUser above); the
      // SUPER_ADMIN_SUB check in hono.ts is done directly against `sub`
      // rather than an org role, so an empty orgs list is correct here.
      orgs: [],
      app: env.AUTH_TPC_RESOURCE ?? null,
      scopes: Array.from(scopes),
      via: "jwt" as const,
      claims: payload as Record<string, unknown>,
      actor: actorSub ? { sub: actorSub } : undefined,
    },
  };
}

/**
 * Gets the team from the token. Also will check if the token is valid.
 *
 * The bearer token is either an opaque useSend API key (`us_...`, unchanged
 * behavior) or a TPC Auth access token (JWT), verified against TPC's JWKS.
 */
export const getTeamFromToken = async (c: Context) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader) {
    throw new UnsendApiError({
      code: "UNAUTHORIZED",
      message: "No Authorization header provided",
    });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    throw new UnsendApiError({
      code: "UNAUTHORIZED",
      message: "No Authorization header provided",
    });
  }

  if (!looksLikeApiKey(token)) {
    return getTeamFromTpcToken(token, requiredScopeForRequest(c));
  }

  const teamAndApiKey = await getTeamAndApiKey(token);

  if (!teamAndApiKey) {
    throw new UnsendApiError({
      code: "FORBIDDEN",
      message: "Invalid API token",
    });
  }

  const { team, apiKey } = teamAndApiKey;

  if (!team) {
    throw new UnsendApiError({
      code: "FORBIDDEN",
      message: "Invalid API token",
    });
  }

  // Deprecated path: raw useSend API keys are still accepted, but every use
  // is logged (key id only, never the raw key value) so callers can be
  // migrated to TPC PATs.
  logger.warn(
    { apiKeyId: apiKey.id, teamId: team.id },
    "Deprecated: raw useSend API key used on public API"
  );

  // No await so it won't block the request. Need to be moved to a queue in future
  db.apiKey
    .update({
      where: {
        id: apiKey.id,
      },
      data: {
        lastUsed: new Date(),
      },
    })
    .catch((err) =>
      logger.error({ err }, "Failed to update lastUsed on API key")
    );

  return { ...team, apiKeyId: apiKey.id, apiKey: { domainId: apiKey.domainId } };
};
