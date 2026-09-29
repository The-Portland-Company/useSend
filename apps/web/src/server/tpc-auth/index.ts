export { DEFAULT_ISSUER, PAT_PREFIX, ROLE_RANK, TpcAuthError, resolveIssuer } from "./types.js";
export type { AuthContext, OrgClaim, Role } from "./types.js";

export { verifyAccessToken, contextFromClaims } from "./verify.js";
export type { VerifyOptions } from "./verify.js";

export { authenticate, bearerToken, clearPatCache } from "./authenticate.js";
export type { AuthenticateOptions } from "./authenticate.js";

export { startRevocationPoll, isPolledRevoked, clearRevocationPollState } from "./revocation-poll.js";
export type { StartRevocationPollOptions, RevocationPollHandle } from "./revocation-poll.js";

export { requireApp, requireOrgRole, requireScope, orgRole } from "./guards.js";

export { protectedResourceMetadata, unauthorized, errorResponse } from "./resource.js";
export type { ResourceMetadataOptions, UnauthorizedOptions } from "./resource.js";

export { oidc, authorizeUrl, exchangeCode, refresh, revoke, logoutUrl, discover } from "./oidc.js";
export type { AuthorizeParams, ExchangeCodeParams, RefreshParams, TokenResponse } from "./oidc.js";

export { createPkcePair, generateCodeVerifier, codeChallenge, randomState } from "./pkce.js";

export { reportFeatureRequest } from "./feature-requests.js";
export type { FeatureRequestInput, FeatureRequestKind, FeatureRequestResult } from "./feature-requests.js";

export { requireApproval, canonicalParamsHash } from "./approval.js";
export type { RequireApprovalOptions, RequireApprovalResult, ApprovalRequiredBody } from "./approval.js";

export { isLockedDown, clearLockdownCache } from "./lockdown.js";

export {
  rateLimit,
  rateLimitResponse,
  dailyCap,
  DEFAULT_AGENT_CAPS,
  kvCounterStore,
  postgresCounterStore,
} from "./rate-limit.js";
export type { RateLimitBinding, CounterStore, RateLimitOptions, RateLimitResult, DailyCapOptions } from "./rate-limit.js";
