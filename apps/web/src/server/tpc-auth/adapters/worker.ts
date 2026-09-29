import { authenticate, type AuthenticateOptions } from "../authenticate.js";
import { errorResponse, protectedResourceMetadata, unauthorized } from "../resource.js";
import type { AuthContext } from "../types.js";

/**
 * Cloudflare Workers helpers (also fine on any fetch-handler runtime: Deno,
 * Bun, Hono, itty-router).
 */

export type WorkerHandler = (request: Request, ctx: AuthContext) => Response | Promise<Response>;

/** Guard a fetch handler. Returns the RFC 9728 401 when no valid token. */
export function requireAuth(opts: AuthenticateOptions, handler: WorkerHandler) {
  return async (request: Request): Promise<Response> => {
    const ctx = await authenticate(request, opts);
    if (!ctx) return unauthorized(opts.resource, { description: "a valid TPC access token is required" });
    try {
      return await handler(request, ctx);
    } catch (err) {
      return errorResponse(opts.resource, err);
    }
  };
}

/**
 * Serve the protected-resource metadata documents from inside a fetch handler.
 * Returns null when the path is not one of them, so you can chain it:
 *
 *   const meta = serveResourceMetadata(request, RESOURCE, SCOPES);
 *   if (meta) return meta;
 */
export function serveResourceMetadata(
  request: Request,
  resource: string,
  scopes: string[],
  opts: { documentation?: string } = {},
): Response | null {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/.well-known/oauth-protected-resource")) return null;
  return protectedResourceMetadata(resource, scopes, opts);
}

export { authenticate, unauthorized, protectedResourceMetadata };
