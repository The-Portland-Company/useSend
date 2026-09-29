import { PAT_PREFIX, resolveIssuer, TpcAuthError, type AuthContext, type OrgClaim } from "./types.js";
import { contextFromClaims, verifyAccessToken } from "./verify.js";
import { isPolledRevoked } from "./revocation-poll.js";

const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

export interface AuthenticateOptions {
  /** Your app's resource URI — the audience tokens must carry. */
  resource: string;
  issuer?: string;
  /**
   * Confidential client credentials. When present, PATs are resolved by RFC
   * 7662 introspection instead of RFC 8693 token exchange. Exchange is the
   * default because it needs no secret in your app.
   */
  introspect?: { clientId: string; clientSecret: string };
  /**
   * PAT resolution cache lifetime in ms. Default 15_000 (dropped from 60s in
   * Phase 2 so a revoked PAT stops working within 15s instead of a minute).
   * Set 0 to disable.
   */
  cacheTtlMs?: number;
}

// ------------------------------------------------------------
// PAT cache: a PAT costs a round trip to the IdP to resolve, and an agent
// hammering an endpoint presents the same one every request. Keyed by
// sha256(token) so the raw secret never sits in a map, and short enough that a
// revoked PAT stops working within a minute.
// ------------------------------------------------------------
interface CacheEntry {
  expires: number;
  ctx: AuthContext;
}
const patCache = new Map<string, CacheEntry>();

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Drop everything cached. Exported for tests and for "revoke now" paths. */
export function clearPatCache(): void {
  patCache.clear();
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer") return null;
  const value = rest.join(" ").trim();
  return value || null;
}

/** RFC 8693: swap a PAT for a 15-minute JWT with aud = this resource. */
async function exchangePat(pat: string, issuer: string, resource: string): Promise<AuthContext> {
  const res = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE,
      subject_token: pat,
      subject_token_type: ACCESS_TOKEN_TYPE,
      resource,
    }),
  });
  if (!res.ok) throw new TpcAuthError("personal access token rejected");
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new TpcAuthError("token exchange returned no access token");
  const payload = await verifyAccessToken(json.access_token, { resource, issuer });
  if (isPolledRevoked(payload)) throw new TpcAuthError("token is revoked");
  return contextFromClaims(payload, "pat");
}

/** RFC 7662: ask the IdP what a token is. Needs a confidential client. */
async function introspectToken(
  token: string,
  issuer: string,
  creds: { clientId: string; clientSecret: string },
): Promise<AuthContext> {
  const res = await fetch(`${issuer}/oauth/introspect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`,
    },
    body: new URLSearchParams({ token }),
  });
  if (!res.ok) throw new TpcAuthError("introspection failed");
  const data = (await res.json()) as Record<string, unknown>;
  if (data.active !== true) throw new TpcAuthError("token is not active");
  const orgs = Array.isArray(data.orgs) ? (data.orgs as OrgClaim[]) : [];
  const ctx: AuthContext = {
    sub: String(data.sub ?? ""),
    orgs,
    app: typeof data.app === "string" ? data.app : null,
    scopes: typeof data.scope === "string" && data.scope ? data.scope.split(" ") : [],
    via: "introspection",
    claims: data,
  };
  if (typeof data.username === "string") ctx.email = data.username;
  if (data.act && typeof data.act === "object" && typeof (data.act as { sub?: unknown }).sub === "string") {
    ctx.actor = { sub: (data.act as { sub: string }).sub };
  }
  return ctx;
}

/**
 * Authenticate an inbound request.
 *
 * - `Authorization: Bearer <jwt>` is verified locally against JWKS.
 * - `Authorization: Bearer tpc_pat_...` is exchanged (or introspected) at the
 *   IdP and the result is cached for a minute.
 *
 * Returns null — never throws — when there is no usable credential, so a route
 * can fall through to `unauthorized(resource)` without a try/catch.
 */
export async function authenticate(request: Request, opts: AuthenticateOptions): Promise<AuthContext | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const issuer = resolveIssuer(opts.issuer);
  const resource = opts.resource.replace(/\/$/, "");

  if (token.startsWith(PAT_PREFIX)) {
    const ttl = opts.cacheTtlMs ?? 15_000;
    const key = `${resource}:${await sha256Hex(token)}`;
    if (ttl > 0) {
      const hit = patCache.get(key);
      if (hit && hit.expires > Date.now()) return hit.ctx;
      if (hit) patCache.delete(key);
    }
    try {
      const ctx = opts.introspect
        ? await introspectToken(token, issuer, opts.introspect)
        : await exchangePat(token, issuer, resource);
      if (ttl > 0) patCache.set(key, { ctx, expires: Date.now() + ttl });
      return ctx;
    } catch {
      return null;
    }
  }

  try {
    const payload = await verifyAccessToken(token, { resource, issuer });
    if (isPolledRevoked(payload)) return null;
    return contextFromClaims(payload, "jwt");
  } catch {
    return null;
  }
}
