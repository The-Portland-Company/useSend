import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import { resolveIssuer, TpcAuthError, type AuthContext, type OrgClaim } from "./types.js";

/**
 * JWKS sets are cached per issuer for the life of the isolate. jose handles the
 * HTTP caching, cooldowns and `kid` rotation; creating a new set per request
 * would refetch the keys on every call and defeat all of that.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(issuer: string) {
  let set = jwksCache.get(issuer);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
      cacheMaxAge: 10 * 60 * 1000,
      cooldownDuration: 30 * 1000,
    });
    jwksCache.set(issuer, set);
  }
  return set;
}

export interface VerifyOptions {
  /** The audience this token must carry: your app's resource URI (RFC 8707). */
  resource: string;
  /** Defaults to https://auth.theportlandcompany.com (or $TPC_AUTH_ISSUER). */
  issuer?: string;
  /** Clock skew tolerance, seconds. Default 30. */
  clockToleranceSec?: number;
}

/**
 * Verify a TPC access token locally against the IdP's JWKS.
 *
 * No network call per request after the first (keys are cached), no shared
 * secret, no callback to the IdP: the signature, the issuer and the audience
 * are the whole check. A token minted for another app fails here, which is the
 * entire point of asking for a resource-bound token.
 */
export async function verifyAccessToken(token: string, opts: VerifyOptions): Promise<JWTPayload> {
  const issuer = resolveIssuer(opts.issuer);
  const resource = opts.resource.replace(/\/$/, "");

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new TpcAuthError("malformed token");
  }
  if (header.typ && header.typ !== "at+jwt" && header.typ !== "application/at+jwt") {
    throw new TpcAuthError(`not an access token (typ=${header.typ})`);
  }

  try {
    const { payload } = await jwtVerify(token, jwks(issuer), {
      issuer,
      audience: resource,
      clockTolerance: opts.clockToleranceSec ?? 30,
    });
    return payload;
  } catch (err) {
    throw new TpcAuthError(err instanceof Error ? err.message : "token verification failed");
  }
}

/** Normalise verified claims into the shape apps actually consume. */
export function contextFromClaims(payload: JWTPayload, via: AuthContext["via"]): AuthContext {
  const p = payload as JWTPayload & Record<string, unknown>;
  const orgs = Array.isArray(p.orgs) ? (p.orgs as OrgClaim[]) : [];
  const ctx: AuthContext = {
    sub: String(p.sub ?? ""),
    orgs,
    app: typeof p.app === "string" ? p.app : null,
    scopes: typeof p.scope === "string" && p.scope ? p.scope.split(" ") : [],
    via,
    claims: p,
  };
  if (typeof p.email === "string") ctx.email = p.email;
  if (typeof p.name === "string") ctx.name = p.name;
  if (typeof p.picture === "string") ctx.picture = p.picture;
  if (typeof p.client_id === "string" && p.client_id.startsWith("pat:")) {
    ctx.patPrefix = p.client_id.slice(4);
  }
  if (p.act && typeof p.act === "object" && typeof (p.act as { sub?: unknown }).sub === "string") {
    ctx.actor = { sub: (p.act as { sub: string }).sub };
  }
  return ctx;
}
