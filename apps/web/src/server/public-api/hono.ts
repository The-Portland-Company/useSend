import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { Context, Next } from "hono";
import { handleError } from "./api-error";
import { env } from "~/env";
import { getRedis, redisKey } from "~/server/redis";
import { getTeamFromToken, TeamAuthContext } from "~/server/public-api/auth";
import { isSelfHosted } from "~/utils/common";
import { UnsendApiError } from "./api-error";
import { Team, ApiKey } from "@prisma/client";
import { logger } from "../logger/log";
import { db } from "../db";
import {
  requireApproval,
  isLockedDown,
  startRevocationPoll,
  dailyCap,
  postgresCounterStore,
} from "~/server/tpc-auth";

// Define AppEnv for Hono context
export type AppEnv = {
  Variables: {
    team: TeamAuthContext;
  };
};

/**
 * usesend:send (write tier, single/transactional send) and usesend:campaign
 * (danger tier, bulk/campaign/broadcast sends) replace the old single
 * usesend:write scope. For one release, a legacy usesend:write PAT still
 * satisfies usesend:send only — it never grants usesend:campaign.
 */
const SEND_SCOPE = "usesend:send";
const CAMPAIGN_SCOPE = "usesend:campaign";
const LEGACY_WRITE_SCOPE = "usesend:write";

function hasScope(scopes: string[], required: string): boolean {
  if (scopes.includes(required)) return true;
  if (required === SEND_SCOPE && scopes.includes(LEGACY_WRITE_SCOPE)) return true;
  return false;
}

// Paths that perform a bulk/campaign/broadcast send and therefore need
// usesend:campaign + requireApproval for agent/PAT callers, vs. a single
// transactional send that only needs usesend:send.
const CAMPAIGN_PATH_PREFIXES = ["/api/v1/campaigns"];
const BULK_SEND_PATHS = ["/api/v1/emails/batch"];

function isCampaignRequest(path: string): boolean {
  return (
    CAMPAIGN_PATH_PREFIXES.some((p) => path.startsWith(p)) ||
    BULK_SEND_PATHS.some((p) => path.startsWith(p))
  );
}

function isSendRequest(method: string, path: string): boolean {
  if (!["POST", "PATCH", "PUT"].includes(method)) return false;
  return path.startsWith("/api/v1/emails") || path.startsWith("/api/v1/campaigns");
}

// Poll TPC revocations once per process at boot. Guarded module-level so
// hot-reload / multiple getApp() calls in the same process don't start it
// twice.
let revocationPollStarted = false;
function ensureRevocationPollStarted() {
  if (revocationPollStarted) return;
  if (!env.TPC_ISSUER || !env.TPC_LOCKDOWN_CREDENTIAL) return;
  revocationPollStarted = true;
  try {
    startRevocationPoll({
      issuer: env.TPC_ISSUER,
      credential: env.TPC_LOCKDOWN_CREDENTIAL,
    });
  } catch (err) {
    logger.error({ err }, "Failed to start TPC revocation poll");
  }
}

const emailSendCounterStore = postgresCounterStore(async (sql, params) => {
  const rows = await db.$queryRawUnsafe<{ count: number }[]>(sql, ...params);
  return rows;
});

export function getApp() {
  ensureRevocationPollStarted();

  const app = new OpenAPIHono<AppEnv>().basePath("/api");

  app.onError(handleError);

  // Auth and Team Middleware (runs before rate limiter)
  app.use("*", async (c: Context<AppEnv>, next: Next) => {
    if (
      c.req.path.startsWith("/api/v1/doc") ||
      c.req.path.startsWith("/api/v1/ui") ||
      c.req.path === "/api/health"
    ) {
      return next();
    }

    try {
      const team = await getTeamFromToken(c as any);
      c.set("team", team as TeamAuthContext);
    } catch (error) {
      if (error instanceof UnsendApiError) {
        throw error;
      }
      logger.error({ err: error }, "Error in getTeamFromToken middleware");
      throw new UnsendApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Authentication failed",
      });
    }
    await next();
  });

  // TPC scope / approval / lockdown / dailyCap middleware. Only applies to
  // TPC PAT/JWT callers (team.tpcAuth is set) — raw usesend API keys keep
  // their existing ApiPermission (FULL/SENDING) behavior untouched.
  app.use("*", async (c: Context<AppEnv>, next: Next) => {
    const team = c.var.team as any;
    if (!team?.tpcAuth) return next();

    const ctx = team.tpcAuth;
    const path = c.req.path;
    const method = c.req.method;

    if (!isSendRequest(method, path)) return next();

    // Lockdown: reject sends for non-super-admins when TPC is locked down.
    // Fail open if the lockdown check itself is unreachable.
    if (env.TPC_ISSUER && env.TPC_LOCKDOWN_CREDENTIAL) {
      const isSuperAdmin = ctx.orgs.some((o: { role: string }) => o.role === "owner");
      if (!isSuperAdmin) {
        try {
          const locked = await isLockedDown(env.TPC_ISSUER, env.TPC_LOCKDOWN_CREDENTIAL);
          if (locked) {
            throw new UnsendApiError({
              code: "SERVICE_UNAVAILABLE",
              message: "Sends are temporarily locked down",
            });
          }
        } catch (err) {
          if (err instanceof UnsendApiError) throw err;
          logger.error({ err }, "TPC isLockedDown check failed; failing open");
        }
      }
    }

    const requiredScope = isCampaignRequest(path) ? CAMPAIGN_SCOPE : SEND_SCOPE;
    if (!hasScope(ctx.scopes, requiredScope)) {
      throw new UnsendApiError({
        code: "FORBIDDEN",
        message: `Missing scope "${requiredScope}"`,
      });
    }

    // Campaign/broadcast/bulk sends by a PAT or agent caller require
    // approval. Public-api callers are always credential-based (no human
    // browser session reaches this path), so there is no session exemption
    // to apply here — every caller on this path is subject to approval.
    if (isCampaignRequest(path)) {
      const result = await requireApproval(c.req.raw, {
        issuer: env.TPC_ISSUER,
        app: env.TPC_APP_ID ?? "usesend",
        action: `${method} ${path}`,
        params: { path, method },
        sub: ctx.sub,
      });
      if (!result.ok) return result.response;
    }

    // Agent callers (ctx.actor set) get a 200/day cap on email.send.
    if (ctx.actor) {
      const capResult = await dailyCap(ctx, "email.send", emailSendCounterStore, {
        max: 200,
      });
      if (!capResult.ok) {
        return Response.json(
          { error: "rate_limited", retry_after: capResult.retryAfter },
          { status: 429, headers: { "Retry-After": String(capResult.retryAfter) } }
        );
      }
    }

    // Log the actor driving this credential on every send.
    logger.info(
      { tpcSub: ctx.sub, tpcActor: ctx.actor?.sub ?? ctx.sub, path },
      "TPC-authenticated send"
    );

    await next();
  });

  // Custom Rate Limiter Middleware
  const RATE_LIMIT_WINDOW_SECONDS = 1;

  app.use("*", async (c: Context<AppEnv>, next: Next) => {
    // Skip for self-hosted, or if team is not set (e.g. for public/doc paths not caught earlier)
    // or if the path is one of the explicitly skipped paths for auth.
    if (
      isSelfHosted() ||
      !c.var.team || // Team should be set by auth middleware for protected routes
      c.req.path.startsWith("/api/v1/doc") ||
      c.req.path.startsWith("/api/v1/ui") ||
      c.req.path === "/api/health"
    ) {
      return next();
    }

    const team = c.var.team;
    const limit = team.apiRateLimit ?? 2; // Default limit from your previous setup
    const key = redisKey(`rl:${team.id}`); // Rate limit key for Redis
    const redis = getRedis();

    let currentRequests: number;
    let ttl: number;

    try {
      // Increment the key. If the key does not exist, it is created and set to 1.
      currentRequests = await redis.incr(key);

      if (currentRequests === 1) {
        // This is the first request in the window, set the expiry.
        await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
      }
      // Get the TTL (time to live) of the key to know when it resets.
      // If the key does not exist or has no expiry, TTL returns -1 or -2.
      // We rely on expire being set for new keys.
      ttl = await redis.ttl(key);
    } catch (error) {
      logger.error({ err: error }, "Redis error during rate limiting");
      // Alternatively, you could fail closed by throwing an error here.
      return next();
    }

    const resetTime =
      Math.floor(Date.now() / 1000) +
      (ttl > 0 ? ttl : RATE_LIMIT_WINDOW_SECONDS);
    const remainingRequests = Math.max(0, limit - currentRequests);

    c.res.headers.set("X-RateLimit-Limit", String(limit));
    c.res.headers.set("X-RateLimit-Remaining", String(remainingRequests));
    c.res.headers.set("X-RateLimit-Reset", String(resetTime));

    if (currentRequests > limit) {
      c.res.headers.set(
        "Retry-After",
        String(ttl > 0 ? ttl : RATE_LIMIT_WINDOW_SECONDS)
      );
      throw new UnsendApiError({
        code: "RATE_LIMITED",
        message: `Rate limit exceeded. Try again in ${ttl > 0 ? ttl : RATE_LIMIT_WINDOW_SECONDS} seconds.`,
      });
    }

    await next();
  });

  // The OpenAPI documentation will be available at /doc
  app.doc("/v1/doc", (c) => ({
    openapi: "3.0.0",
    info: {
      version: "1.0.0",
      title: "useSend API",
    },
    servers: [{ url: `${env.NEXTAUTH_URL}/api` }],
  }));

  app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
    type: "http",
    scheme: "bearer",
  });

  app.get("/v1/ui", swaggerUI({ url: "/api/v1/doc" }));

  return app;
}

export type PublicAPIApp = OpenAPIHono<AppEnv>;
