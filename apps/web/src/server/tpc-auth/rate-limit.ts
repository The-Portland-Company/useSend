import type { AuthContext } from "./types.js";

/**
 * Rate limiting and per-agent daily caps.
 *
 * Two backends are supported:
 *  - The Cloudflare Workers rate-limit binding (`wrangler.jsonc` `ratelimits`),
 *    good for short sliding windows on Workers.
 *  - A pluggable `CounterStore`, for Railway apps (no binding available) and
 *    for UTC-day windows the binding can't express.
 *
 * Both key on the caller's credential, not IP: `ctx.actor?.sub ?? ctx.sub`,
 * plus the token id when known, so one agent's PAT can't starve another
 * caller sharing an egress IP, and can't be starved by a sibling PAT either.
 */

/** Shape of a Cloudflare Workers rate-limit binding (`env.MY_RATE_LIMITER`). */
export interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

/** A pluggable fixed-window counter. `incr` returns the count *after* incrementing. */
export interface CounterStore {
  incr(key: string, ttlSec: number): Promise<number>;
}

export interface RateLimitOptions {
  /** A Cloudflare Workers rate-limit binding, for short windows. */
  binding?: RateLimitBinding;
  /** Requests allowed per window. Only used with `store` (the binding has its own limit baked in). */
  limit?: number;
  /** Window length in seconds. Only used with `store`. */
  periodSec?: number;
  /** A `CounterStore`, for Railway apps or windows the binding can't express. */
  store?: CounterStore;
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number };

/** The caller's own identity for rate-limiting purposes: actor if present (agent/client), else sub. */
function callerKey(ctx: AuthContext): string {
  const who = ctx.actor?.sub ?? ctx.sub;
  const tokenId = ctx.patPrefix ?? (typeof ctx.claims.jti === "string" ? ctx.claims.jti : undefined);
  return tokenId ? `${who}:${tokenId}` : who;
}

const DEFAULT_LIMIT = 60;
const DEFAULT_PERIOD_SEC = 60;

/**
 * Enforce a rate limit for this caller under `key` (e.g. "email.send").
 * Prefers `binding` when given; falls back to `store` (a fixed window of
 * `limit` requests per `periodSec`, default 60/60s).
 */
export async function rateLimit(ctx: AuthContext, key: string, opts: RateLimitOptions = {}): Promise<RateLimitResult> {
  const who = callerKey(ctx);
  const compositeKey = `${key}:${who}`;

  if (opts.binding) {
    const { success } = await opts.binding.limit({ key: compositeKey });
    return success ? { ok: true } : { ok: false, retryAfter: opts.periodSec ?? DEFAULT_PERIOD_SEC };
  }

  if (opts.store) {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const periodSec = opts.periodSec ?? DEFAULT_PERIOD_SEC;
    const count = await opts.store.incr(compositeKey, periodSec);
    return count <= limit ? { ok: true } : { ok: false, retryAfter: periodSec };
  }

  // No backend configured: fail open rather than crash the route.
  return { ok: true };
}

/** A ready-made 429 response with `Retry-After` set, for a failed `rateLimit`/`dailyCap` result. */
export function rateLimitResponse(result: { ok: false; retryAfter: number }): Response {
  return Response.json(
    { error: "rate_limited", retry_after: result.retryAfter },
    { status: 429, headers: { "Retry-After": String(result.retryAfter) } },
  );
}

// ============================================================
// Daily caps
// ============================================================

/** Per-agent-action daily caps (UTC day window). Humans (no `ctx.actor`) are never capped. */
export const DEFAULT_AGENT_CAPS: Record<string, number> = {
  "email.send": 200,
  "ads.rule_change": 20,
  "inbox.mailbox_create": 50,
  "swarm.sweep": 10,
};

export interface DailyCapOptions {
  /** Override the default max for this action, if any. */
  max?: number;
  /** Fired when the cap is hit, so the caller can raise a "quota exhaustion" alert. */
  onCapHit?: (ctx: AuthContext, action: string, max: number) => void | Promise<void>;
}

function secondsUntilNextUtcDay(): number {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return Math.max(1, Math.round((midnight - now.getTime()) / 1000));
}

/**
 * Cap an agent action to `max` (default from `DEFAULT_AGENT_CAPS`) per UTC
 * day. A no-op for human callers — `ctx.actor` is only set for agent PATs
 * and MCP client credentials, and humans aren't capped.
 */
export async function dailyCap(
  ctx: AuthContext,
  action: string,
  store: CounterStore,
  opts: DailyCapOptions = {},
): Promise<RateLimitResult> {
  if (!ctx.actor) return { ok: true };

  const max = opts.max ?? DEFAULT_AGENT_CAPS[action];
  if (max === undefined) return { ok: true };

  const ttlSec = secondsUntilNextUtcDay();
  const day = new Date().toISOString().slice(0, 10);
  const key = `cap:${action}:${ctx.actor.sub}:${day}`;
  const count = await store.incr(key, ttlSec);

  if (count > max) {
    await opts.onCapHit?.(ctx, action, max);
    return { ok: false, retryAfter: ttlSec };
  }
  return { ok: true };
}

// ============================================================
// CounterStore adapters
// ============================================================

/** Best-effort `CounterStore` backed by Workers KV. Not perfectly atomic (read-then-write), fine for soft caps. */
export function kvCounterStore(kv: {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}): CounterStore {
  return {
    async incr(key: string, ttlSec: number): Promise<number> {
      const current = await kv.get(key);
      const next = (current ? parseInt(current, 10) || 0 : 0) + 1;
      await kv.put(key, String(next), { expirationTtl: Math.max(60, ttlSec) });
      return next;
    },
  };
}

/**
 * Atomic `CounterStore` backed by Postgres, via the `incr_quota_counter(key, ttl_sec)`
 * function from the SDK's migration (supabase/migrations/*_agent_quota_counters.sql).
 * `query` runs one parameterized statement and returns its rows.
 */
export function postgresCounterStore(query: (sql: string, params: unknown[]) => Promise<{ count: number }[]>): CounterStore {
  return {
    async incr(key: string, ttlSec: number): Promise<number> {
      const rows = await query("select incr_quota_counter($1, $2) as count", [key, ttlSec]);
      return rows[0]?.count ?? 0;
    },
  };
}
