import { resolveIssuer } from "./types.js";

export interface FeatureRequestInput {
  /** A PAT or an access token identifying who is asking. */
  token: string;
  /** App id the request is about, e.g. "forge". */
  app: string;
  title: string;
  detail: string;
  /** Defaults to "missing_feature". */
  kind?: FeatureRequestKind;
  severity?: "low" | "normal" | "high" | "blocker";
  issuer?: string;
}

export type FeatureRequestKind = "missing_feature" | "bug" | "migration_blocker" | "question";

export interface FeatureRequestResult {
  ok: boolean;
  id?: string;
  status?: number;
  error?: string;
}

/**
 * File a feature request against TPC Auth.
 *
 * This is the escape hatch that keeps the system closed: when the IdP cannot do
 * something your app needs, you say so here instead of rebuilding identity
 * locally. Never swallow the gap — a local workaround is the thing this whole
 * migration exists to delete.
 */
export async function reportFeatureRequest(input: FeatureRequestInput): Promise<FeatureRequestResult> {
  const issuer = resolveIssuer(input.issuer);
  try {
    const res = await fetch(`${issuer}/api/v1/feature-requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify({
        appId: input.app,
        kind: input.kind ?? "missing_feature",
        title: input.title,
        body: input.detail,
        ...(input.severity ? { severity: input.severity } : {}),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      request?: { id?: string };
      error?: string | { message?: string };
    };
    if (!res.ok) {
      const e = typeof json.error === "string" ? json.error : json.error?.message;
      return { ok: false, status: res.status, error: e ?? `HTTP ${res.status}` };
    }
    const id = json.request?.id ?? json.id;
    return { ok: true, status: res.status, ...(id ? { id } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "request failed" };
  }
}
