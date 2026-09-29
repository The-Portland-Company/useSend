import { resolveIssuer, TpcAuthError } from "./types.js";

export interface ResourceMetadataOptions {
  issuer?: string;
  /** Where humans/agents can read about this resource. */
  documentation?: string;
}

/**
 * RFC 9728 protected-resource metadata, as a ready-to-return Response.
 *
 * Serve it at `/.well-known/oauth-protected-resource` (and
 * `/.well-known/oauth-protected-resource/mcp` for an MCP server). It is the
 * only thing that tells an unknown MCP client which authorization server to go
 * and register with.
 */
export function protectedResourceMetadata(
  resource: string,
  scopes: string[],
  opts: ResourceMetadataOptions = {},
): Response {
  const issuer = resolveIssuer(opts.issuer);
  return Response.json(
    {
      resource: resource.replace(/\/$/, ""),
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: scopes,
      ...(opts.documentation ? { resource_documentation: opts.documentation } : {}),
    },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}

export interface UnauthorizedOptions {
  error?: string;
  description?: string;
  status?: number;
  /** Defaults to `<resource origin>/.well-known/oauth-protected-resource`. */
  metadataUrl?: string;
  scope?: string;
}

/**
 * A 401 (or 403) whose `WWW-Authenticate` points at this resource's metadata —
 * the handshake that lets an MCP client discover the IdP and authenticate
 * without anyone hard-coding anything.
 */
export function unauthorized(resource: string, opts: UnauthorizedOptions = {}): Response {
  const clean = resource.replace(/\/$/, "");
  let metadataUrl = opts.metadataUrl;
  if (!metadataUrl) {
    try {
      const url = new URL(clean);
      const suffix = url.pathname && url.pathname !== "/" ? url.pathname : "";
      metadataUrl = `${url.origin}/.well-known/oauth-protected-resource${suffix}`;
    } catch {
      metadataUrl = `${clean}/.well-known/oauth-protected-resource`;
    }
  }
  const error = opts.error ?? "invalid_token";
  const parts = [
    `Bearer resource_metadata="${metadataUrl}"`,
    `error="${error}"`,
    ...(opts.description ? [`error_description="${opts.description.replace(/"/g, "'")}"`] : []),
    ...(opts.scope ? [`scope="${opts.scope}"`] : []),
  ];
  return Response.json(
    { error, ...(opts.description ? { error_description: opts.description } : {}) },
    {
      status: opts.status ?? 401,
      headers: {
        "WWW-Authenticate": parts.join(", "),
        "Cache-Control": "no-store",
      },
    },
  );
}

/** Turn a thrown TpcAuthError into the right Response for `resource`. */
export function errorResponse(resource: string, err: unknown): Response {
  if (err instanceof TpcAuthError) {
    return unauthorized(resource, { error: err.code, description: err.message, status: err.status });
  }
  return unauthorized(resource, { error: "invalid_token", description: "authentication failed" });
}
