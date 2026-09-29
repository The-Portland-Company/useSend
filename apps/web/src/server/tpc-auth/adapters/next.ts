import { authenticate, type AuthenticateOptions } from "../authenticate.js";
import { errorResponse, protectedResourceMetadata, unauthorized } from "../resource.js";
import type { AuthContext } from "../types.js";

/**
 * Next.js App Router helpers.
 *
 * Nothing here imports from `next` — Route Handlers take a web `Request` and
 * return a web `Response`, so the adapter is just ergonomics.
 */

export type AuthedHandler<T = unknown> = (
  request: Request,
  ctx: AuthContext,
  routeContext: T,
) => Response | Promise<Response>;

/**
 * Wrap a Route Handler so it only runs for an authenticated caller, and
 * answers everyone else with the RFC 9728 401 an MCP client knows how to
 * follow.
 *
 *   export const GET = withAuth({ resource: RESOURCE }, async (req, ctx) =>
 *     Response.json({ you: ctx.sub, orgs: ctx.orgs }));
 */
export function withAuth<T = unknown>(opts: AuthenticateOptions, handler: AuthedHandler<T>) {
  return async (request: Request, routeContext: T): Promise<Response> => {
    const ctx = await authenticate(request, opts);
    if (!ctx) return unauthorized(opts.resource, { description: "a valid TPC access token is required" });
    try {
      return await handler(request, ctx, routeContext);
    } catch (err) {
      return errorResponse(opts.resource, err);
    }
  };
}

/** A ready-made `/.well-known/oauth-protected-resource` route handler. */
export function protectedResourceRoute(resource: string, scopes: string[], documentation?: string) {
  return () => protectedResourceMetadata(resource, scopes, documentation ? { documentation } : {});
}

export { authenticate, unauthorized, protectedResourceMetadata };
