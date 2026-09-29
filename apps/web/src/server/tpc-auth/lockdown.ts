import { resolveIssuer } from "./types.js";

/**
 * Polls GET /api/v1/lockdown — the `lockdown` KV flag an IdP super admin can
 * flip via the `lockdown`/`unlock` MCP tools (lib/mcp/tools.ts). Not wired
 * into any app; a consuming app decides for itself what "locked down" means
 * (typically: reject writes, keep serving reads).
 *
 * Caches the result for 15s in-process so a hot path can call this on every
 * request without hammering the IdP.
 */

const CACHE_MS = 15_000;

let cached: { value: boolean; at: number } | null = null;

export async function isLockedDown(issuer?: string, credential?: string): Promise<boolean> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  if (!credential) throw new Error("isLockedDown: a credential is required (PAT or access token)");

  const base = resolveIssuer(issuer);
  const res = await fetch(`${base}/api/v1/lockdown`, {
    headers: { Authorization: `Bearer ${credential}` },
  });
  if (!res.ok) throw new Error(`GET /api/v1/lockdown returned ${res.status}`);
  const { lockdown } = (await res.json()) as { lockdown?: boolean };
  const value = lockdown === true;
  cached = { value, at: Date.now() };
  return value;
}

/** Test hook: clears the in-process cache. */
export function clearLockdownCache(): void {
  cached = null;
}
