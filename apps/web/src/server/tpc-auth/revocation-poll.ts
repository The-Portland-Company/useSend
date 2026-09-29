import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { resolveIssuer } from "./types.js";

/**
 * Optional background poll of GET /oauth/revocations (Phase 2 "faster
 * revocation"). `authenticate()` verifies access tokens locally against JWKS
 * with no per-request call to the IdP, which is the whole point of a JWT —
 * but it also means a token revoked at /oauth/revoke or a consent revoked at
 * /account/agents keeps working here until it expires on its own. This poll
 * closes that gap for apps that opt in, without adding a network call to the
 * hot path: it keeps an in-memory set/map that `authenticate()` consults for
 * free, and refreshes it every `intervalMs`.
 *
 * Not started automatically — call `startRevocationPoll` once, at boot, in
 * any app that wants tokens to die faster than their own TTL.
 */

interface RevokedBeforeEntry {
  sub: string;
  clientId?: string;
  before: number;
}

interface RevocationFeedPayload extends JWTPayload {
  jtis?: string[];
  revoked_before?: RevokedBeforeEntry[];
}

let revokedJtis = new Set<string>();
let revokedBeforeGlobal = new Map<string, number>();
let revokedBeforeByClient = new Map<string, number>();

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

export interface StartRevocationPollOptions {
  issuer?: string;
  /** Poll interval, ms. Default 30_000. */
  intervalMs?: number;
  /** Called with the error on a failed poll; the previous feed keeps applying. */
  onError?: (err: unknown) => void;
  /**
   * A credential this IdP issued (a PAT, a client_credentials token, or a
   * regular access token), sent as `Authorization: Bearer <credential>` —
   * /oauth/revocations is a closed-system feed and requires one. A string,
   * or an async getter for callers whose credential can rotate (e.g. a
   * short-lived client_credentials token they refresh themselves).
   * Without one, polling is skipped (logged via `onError`, not thrown) —
   * apps with no credential to spare fall back to relying on each token's
   * own TTL.
   */
  credential?: string | (() => string | null | Promise<string | null>);
}

export interface RevocationPollHandle {
  /** Stop polling. Does not clear the in-memory feed already applied. */
  stop(): void;
}

async function resolveCredential(
  credential: StartRevocationPollOptions["credential"],
): Promise<string | null> {
  if (!credential) return null;
  return typeof credential === "function" ? await credential() : credential;
}

async function fetchFeed(issuer: string, credential: string): Promise<void> {
  const res = await fetch(`${issuer}/oauth/revocations`, {
    headers: { Authorization: `Bearer ${credential}` },
  });
  if (!res.ok) throw new Error(`GET /oauth/revocations returned ${res.status}`);
  const { revocations } = (await res.json()) as { revocations?: string };
  if (!revocations) throw new Error("revocations feed response had no `revocations` field");

  const { payload } = await jwtVerify(revocations, jwks(issuer), { issuer });
  const p = payload as RevocationFeedPayload;

  const jtis = new Set(Array.isArray(p.jtis) ? p.jtis : []);
  const global = new Map<string, number>();
  const byClient = new Map<string, number>();
  for (const entry of Array.isArray(p.revoked_before) ? p.revoked_before : []) {
    if (!entry || typeof entry.sub !== "string" || typeof entry.before !== "number") continue;
    if (entry.clientId) byClient.set(`${entry.sub}:${entry.clientId}`, entry.before);
    else global.set(entry.sub, entry.before);
  }

  revokedJtis = jtis;
  revokedBeforeGlobal = global;
  revokedBeforeByClient = byClient;
}

/**
 * Start polling GET /oauth/revocations in the background. Fetches once
 * immediately. No-ops (after one `onError` warning) if `opts.credential`
 * resolves to nothing — the endpoint requires auth and there's nothing to
 * send.
 */
export function startRevocationPoll(opts: StartRevocationPollOptions = {}): RevocationPollHandle {
  const issuer = resolveIssuer(opts.issuer);
  const intervalMs = opts.intervalMs ?? 30_000;

  const tick = () => {
    resolveCredential(opts.credential)
      .then((credential) => {
        if (!credential) {
          opts.onError?.(
            new Error("startRevocationPoll: no credential provided; skipping poll (see `credential` option)"),
          );
          return;
        }
        return fetchFeed(issuer, credential);
      })
      .catch((err) => opts.onError?.(err));
  };
  tick();
  const timer: ReturnType<typeof setInterval> = setInterval(tick, intervalMs);
  // Don't hold the process open just for this poll (Node only; no-op elsewhere).
  (timer as unknown as { unref?: () => void }).unref?.();

  return { stop: () => clearInterval(timer) };
}

/** True if the polled feed says this access-token payload is revoked. Fails open when no poll is running. */
export function isPolledRevoked(payload: JWTPayload & Record<string, unknown>): boolean {
  const jti = typeof payload.jti === "string" ? payload.jti : null;
  if (jti && revokedJtis.has(jti)) return true;

  const sub = typeof payload.sub === "string" ? payload.sub : null;
  const iat = typeof payload.iat === "number" ? payload.iat : null;
  if (!sub || iat === null) return false;

  const globalCutoff = revokedBeforeGlobal.get(sub);
  if (globalCutoff !== undefined && iat < globalCutoff) return true;

  const clientId = typeof payload.client_id === "string" ? payload.client_id : null;
  if (clientId) {
    const clientCutoff = revokedBeforeByClient.get(`${sub}:${clientId}`);
    if (clientCutoff !== undefined && iat < clientCutoff) return true;
  }
  return false;
}

/** Test/reset hook: clears the in-memory feed without stopping any running poll. */
export function clearRevocationPollState(): void {
  revokedJtis = new Set();
  revokedBeforeGlobal = new Map();
  revokedBeforeByClient = new Map();
}
