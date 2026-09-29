import { resolveIssuer, TpcAuthError } from "./types.js";
import { codeChallenge } from "./pkce.js";

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  /** Default "openid profile email". Add "offline_access" for refresh tokens. */
  scope?: string;
  state: string;
  /** The verifier you keep; the S256 challenge is derived from it here. */
  codeVerifier: string;
  /** RFC 8707: ask for a token whose `aud` is your API/MCP resource. */
  resource?: string;
  nonce?: string;
  /** "login" to force re-authentication, "none" for a silent check. */
  prompt?: "login" | "none" | "consent";
  loginHint?: string;
  issuer?: string;
}

export interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

async function postForm(url: string, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & Partial<TokenResponse>;
  if (!res.ok) {
    throw new TpcAuthError(
      String(json.error_description ?? json.error ?? `token endpoint returned ${res.status}`),
      String(json.error ?? "invalid_grant"),
      res.status,
    );
  }
  return json as TokenResponse;
}

/**
 * Build the /oauth/authorize URL for the authorization-code + PKCE flow.
 * Store `state` and `codeVerifier` in the user's session before redirecting.
 */
export async function authorizeUrl(params: AuthorizeParams): Promise<string> {
  const issuer = resolveIssuer(params.issuer);
  const url = new URL(`${issuer}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scope ?? "openid profile email");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", await codeChallenge(params.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (params.resource) url.searchParams.set("resource", params.resource.replace(/\/$/, ""));
  if (params.nonce) url.searchParams.set("nonce", params.nonce);
  if (params.prompt) url.searchParams.set("prompt", params.prompt);
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  return url.toString();
}

export interface ExchangeCodeParams {
  clientId: string;
  /** Omit for a public (PKCE) client. */
  clientSecret?: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string;
  issuer?: string;
}

/** Swap an authorization code for tokens. */
export async function exchangeCode(params: ExchangeCodeParams): Promise<TokenResponse> {
  const issuer = resolveIssuer(params.issuer);
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    client_id: params.clientId,
  };
  if (params.clientSecret) body.client_secret = params.clientSecret;
  if (params.resource) body.resource = params.resource.replace(/\/$/, "");
  return postForm(`${issuer}/oauth/token`, body);
}

export interface RefreshParams {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  resource?: string;
  issuer?: string;
}

/** Refresh an access token. Refresh tokens rotate: persist the new one. */
export async function refresh(params: RefreshParams): Promise<TokenResponse> {
  const issuer = resolveIssuer(params.issuer);
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  };
  if (params.clientSecret) body.client_secret = params.clientSecret;
  if (params.resource) body.resource = params.resource.replace(/\/$/, "");
  return postForm(`${issuer}/oauth/token`, body);
}

/** RFC 7009: revoke a refresh token, PAT, or access token. Always succeeds. */
export async function revoke(token: string, opts: { issuer?: string } = {}): Promise<void> {
  const issuer = resolveIssuer(opts.issuer);
  await fetch(`${issuer}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined);
}

/** End the IdP session. Send the browser here to sign out everywhere. */
export function logoutUrl(opts: { postLogoutRedirectUri?: string; idTokenHint?: string; issuer?: string } = {}): string {
  const issuer = resolveIssuer(opts.issuer);
  const url = new URL(`${issuer}/oauth/logout`);
  if (opts.postLogoutRedirectUri) url.searchParams.set("post_logout_redirect_uri", opts.postLogoutRedirectUri);
  if (opts.idTokenHint) url.searchParams.set("id_token_hint", opts.idTokenHint);
  return url.toString();
}

/** Fetch the OIDC discovery document. */
export async function discover(issuerUrl?: string): Promise<Record<string, unknown>> {
  const issuer = resolveIssuer(issuerUrl);
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new TpcAuthError(`discovery failed (${res.status})`, "server_error", 502);
  return (await res.json()) as Record<string, unknown>;
}

export const oidc = {
  authorizeUrl,
  exchangeCode,
  refresh,
  revoke,
  logoutUrl,
  discover,
};
