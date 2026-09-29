import { resolveIssuer } from "./types.js";
import { bearerToken } from "./authenticate.js";

/**
 * Human-in-the-loop approvals. An app calls `requireApproval` before running
 * a sensitive action; if the caller hasn't already attached a valid
 * `X-TPC-Approval` token, it returns a 202 telling the agent to request one
 * (POST /api/v1/approvals on the IdP) and retry with the token attached.
 *
 * `canonicalParamsHash` must stay byte-for-byte identical to the IdP's own
 * copy (lib/approvals.ts `canonicalJson`) — both sides hash the same params
 * to the same string.
 */

const APPROVAL_HEADER = "X-TPC-Approval";

export async function canonicalParamsHash(params: unknown): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(params));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export interface RequireApprovalOptions {
  /** Your app's id, as registered with the IdP (also the token's expected `aud`). */
  app: string;
  /** Machine-readable action name, matched against the approval request. */
  action: string;
  /** The action's params — hashed with `canonicalParamsHash`, never sent as-is. */
  params: unknown;
  /**
   * The sub of the user making THIS app request. Required: the IdP checks it against the
   * approval JWT's own sub, so a token minted for one user can't be replayed by anyone
   * else who gets hold of it.
   */
  sub: string;
  /** Your app's own TPC credential (PAT or client JWT), used to call .../consume. Defaults to `bearerToken(req)`. */
  credential?: string;
  issuer?: string;
}

export interface ApprovalRequiredBody {
  approval_required: true;
  request_url: string;
  action: string;
  params_hash: string;
}

export type RequireApprovalResult = { ok: true } | { ok: false; response: Response };

/**
 * Gate a sensitive action on a fresh, one-time human approval.
 *
 * Reads the approval token from `X-TPC-Approval` on `req`. Missing or
 * invalid: returns `{ ok: false, response }` where `response` is a 202 whose
 * JSON body tells the agent to call `POST {issuer}/api/v1/approvals` and
 * retry with the returned token attached. Valid: consumes the token against
 * the IdP (POST /api/v1/approvals/consume) and returns `{ ok: true }` — the
 * caller proceeds with the action. A token can only ever be consumed once.
 */
export async function requireApproval(req: Request, opts: RequireApprovalOptions): Promise<RequireApprovalResult> {
  const issuer = resolveIssuer(opts.issuer);
  const paramsHash = await canonicalParamsHash(opts.params);
  const token = req.headers.get(APPROVAL_HEADER);

  const notRequired = () => {
    const body: ApprovalRequiredBody = {
      approval_required: true,
      request_url: `${issuer}/api/v1/approvals`,
      action: opts.action,
      params_hash: paramsHash,
    };
    return { ok: false as const, response: Response.json(body, { status: 202 }) };
  };

  if (!token) return notRequired();

  const credential = opts.credential ?? bearerToken(req);
  if (!credential) return notRequired();

  let consumeRes: Response;
  try {
    consumeRes = await fetch(`${issuer}/api/v1/approvals/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify({ app: opts.app, action: opts.action, params_hash: paramsHash, token, sub: opts.sub }),
    });
  } catch {
    return notRequired();
  }
  if (!consumeRes.ok) return notRequired();

  return { ok: true };
}
