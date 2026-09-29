/** The canonical issuer. Override per environment with TPC_AUTH_ISSUER. */
export const DEFAULT_ISSUER = "https://auth.theportlandcompany.com";

export const PAT_PREFIX = "tpc_pat_";

export type Role = "viewer" | "member" | "manager" | "admin" | "owner";

export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  member: 1,
  manager: 2,
  admin: 3,
  owner: 4,
};

export interface OrgClaim {
  id: string;
  slug: string;
  name: string;
  role: Role;
}

/** Everything an app needs about the caller, with no lookup of its own. */
export interface AuthContext {
  /** TPC person id (`sub`). Store this as `tpc_sub`. */
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  /** Orgs the person belongs to, with their role in each. */
  orgs: OrgClaim[];
  /** App id the token is bound to, e.g. "forge". Null for IdP-audience tokens. */
  app: string | null;
  /** Granted scopes, split. */
  scopes: string[];
  /** How the caller proved who they are. */
  via: "jwt" | "pat" | "introspection";
  /** Raw verified claims, for anything this interface does not name. */
  claims: Record<string, unknown>;
  /** Present when `via` is "pat" — the token that was exchanged, if known. */
  patPrefix?: string;
  /**
   * RFC 8693 `act` claim — who's actually driving this credential, when it's
   * not the person named by `sub`. `agent:<agent_name>` for an agent PAT
   * exchange, `client:<client_id>` for an MCP dynamic client. Log this
   * alongside `sub` so "agent X on behalf of Spencer" is always reconstructable.
   */
  actor?: { sub: string };
}

export function resolveIssuer(issuer?: string): string {
  const env = typeof process !== "undefined" ? process.env?.TPC_AUTH_ISSUER : undefined;
  return (issuer ?? env ?? DEFAULT_ISSUER).replace(/\/$/, "");
}

export class TpcAuthError extends Error {
  constructor(
    message: string,
    readonly code: string = "invalid_token",
    readonly status: number = 401,
  ) {
    super(message);
    this.name = "TpcAuthError";
  }
}
