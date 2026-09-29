import { Context } from "hono";
import { db } from "../db";
import { UnsendApiError } from "./api-error";
import { getTeamAndApiKey } from "../service/api-service";
import { isSelfHosted } from "~/utils/common";
import { logger } from "../logger/log";
import { env } from "~/env";
import { authenticate, PAT_PREFIX, type AuthContext } from "~/server/tpc-auth";

/** A team/apiKey-shaped context, whichever credential type produced it. */
export type TeamAuthContext = Awaited<ReturnType<typeof getTeamFromToken>>;

function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

/**
 * Resolves a TPC AuthContext's org claim to a usesend Team via Team.tpcOrgId.
 *
 * Placeholder mapping: today Team<->TPC org is assumed 1:1 by whichever org
 * claim is present on the token. If a PAT carries multiple orgs, or a team
 * needs to serve more than one org, this needs product input on which org
 * "wins" — for now we take the first org claim that has a matching team.
 */
async function resolveTeamFromTpcContext(ctx: AuthContext) {
  for (const org of ctx.orgs) {
    const team = await db.team.findUnique({ where: { tpcOrgId: org.id } });
    if (team) return team;
  }
  return null;
}

async function getTeamFromTpcToken(c: Context, token: string) {
  if (!env.TPC_ISSUER || !env.TPC_APP_ID) return null;

  const request = new Request(c.req.url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  let ctx: AuthContext | null = null;
  try {
    ctx = await authenticate(request, {
      resource: env.TPC_APP_ID,
      issuer: env.TPC_ISSUER,
    });
  } catch (err: unknown) {
    logger.error({ err }, "TPC authenticate() threw");
    return null;
  }

  if (!ctx) return null;

  const team = await resolveTeamFromTpcContext(ctx);
  if (!team) {
    throw new UnsendApiError({
      code: "FORBIDDEN",
      message: "TPC identity is not linked to a usesend team",
    });
  }

  return {
    ...team,
    // No usesend ApiKey row backs a TPC credential; callers that need
    // apiKeyId (rate limiting, logging) should prefer tpcSub/tpcActor below.
    apiKeyId: 0,
    apiKey: { domainId: null as number | null },
    tpcAuth: ctx,
    tpcSub: ctx.sub,
    tpcActor: ctx.actor?.sub ?? ctx.sub,
    tpcScopes: ctx.scopes,
  };
}

/**
 * Gets the team from the token. Also will check if the token is valid.
 *
 * Tries a TPC PAT/JWT first (Authorization: Bearer tpc_pat_... or a JWT);
 * falls back to usesend's own raw API keys, logging a deprecation line per
 * use so we can track migration off them.
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

  if (token.startsWith(PAT_PREFIX) || looksLikeJwt(token)) {
    const tpcTeam = await getTeamFromTpcToken(c, token);
    if (tpcTeam) return tpcTeam;
    // Not a valid TPC credential (or TPC_ISSUER/TPC_APP_ID unset) — fall
    // through to the raw-key path below rather than rejecting outright,
    // since a JWT-shaped token isn't proof it was meant to be a TPC token.
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

  // Deprecation notice: raw usesend API keys will eventually require
  // migration to TPC PATs. Never log the raw key, only its id.
  logger.warn(
    { apiKeyId: apiKey.id },
    "Deprecated: raw usesend API key used on public API"
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
