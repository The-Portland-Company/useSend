import { beforeEach, describe, expect, it, vi } from "vitest";
import * as jose from "jose";
import { UnsendApiError } from "~/server/public-api/api-error";

const ISSUER = "https://tpc.example.com";
const RESOURCE = "https://emailmarketing.example.com";

const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  teamUser: { findFirst: vi.fn() },
  apiKey: { update: vi.fn(() => Promise.resolve()) },
}));

const mockGetTeamAndApiKey = vi.hoisted(() => vi.fn());

vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/server/service/api-service", () => ({
  getTeamAndApiKey: mockGetTeamAndApiKey,
}));
vi.mock("~/env", () => ({
  env: {
    AUTH_TPC_ISSUER: ISSUER,
    AUTH_TPC_RESOURCE: RESOURCE,
  },
}));

// createRemoteJWKSet does a real network fetch to `${issuer}/.well-known/jwks.json`;
// swap it for a local JWKS built from the keypair this test signs tokens with, so
// verification is real (signature, issuer, audience, expiry) without any network I/O.
let publicJwk: jose.JWK;
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: () => actual.createLocalJWKSet({ keys: [publicJwk] }),
  };
});

let privateKey: jose.KeyLike;

async function signToken(claims: Record<string, unknown>) {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("getTeamFromToken (TPC JWT + API key)", () => {
  beforeEach(async () => {
    // auth.ts caches its remote JWKS per-issuer at module scope; reset the
    // module registry so each test's fresh keypair gets its own JWKS cache
    // instead of verifying against a previous test's stale key.
    vi.resetModules();

    const { publicKey, privateKey: sk } = await jose.generateKeyPair("RS256");
    privateKey = sk;
    publicJwk = await jose.exportJWK(publicKey);

    mockDb.user.findUnique.mockReset();
    mockDb.teamUser.findFirst.mockReset();
    mockGetTeamAndApiKey.mockReset();
  });

  it("accepts a valid TPC token with usesend:send scope for a send route", async () => {
    const token = await signToken({ sub: "tpc-user-1", scope: "usesend:send" });

    mockDb.user.findUnique.mockResolvedValue({ id: 1, tpcSub: "tpc-user-1" });
    mockDb.teamUser.findFirst.mockResolvedValue({
      userId: 1,
      teamId: 42,
      team: { id: 42, name: "Acme" },
    });

    const { getTeamFromToken } = await import("~/server/public-api/auth");

    const c = {
      req: {
        header: () => `Bearer ${token}`,
        method: "POST",
        path: "/api/v1/emails",
      },
    } as any;

    const team = await getTeamFromToken(c);
    expect(team.id).toBe(42);
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({
      where: { tpcSub: "tpc-user-1" },
    });
  });

  it("rejects a TPC token missing the usesend:send scope for a send route", async () => {
    const token = await signToken({ sub: "tpc-user-1", scope: "usesend:read" });

    const { getTeamFromToken } = await import("~/server/public-api/auth");

    const c = {
      req: {
        header: () => `Bearer ${token}`,
        method: "POST",
        path: "/api/v1/emails",
      },
    } as any;

    await expect(getTeamFromToken(c)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("allows a token with only usesend:read scope on a GET route", async () => {
    const token = await signToken({ sub: "tpc-user-1", scope: "usesend:read" });

    mockDb.user.findUnique.mockResolvedValue({ id: 1, tpcSub: "tpc-user-1" });
    mockDb.teamUser.findFirst.mockResolvedValue({
      userId: 1,
      teamId: 42,
      team: { id: 42, name: "Acme" },
    });

    const { getTeamFromToken } = await import("~/server/public-api/auth");

    const c = {
      req: {
        header: () => `Bearer ${token}`,
        method: "GET",
        path: "/api/v1/emails/abc",
      },
    } as any;

    const team = await getTeamFromToken(c);
    expect(team.id).toBe(42);
  });

  it("rejects a token with a bad signature", async () => {
    const token = await signToken({ sub: "tpc-user-1", scope: "usesend:send" });
    const tampered = token.slice(0, -2) + "aa";

    const { getTeamFromToken } = await import("~/server/public-api/auth");

    const c = {
      req: {
        header: () => `Bearer ${tampered}`,
        method: "POST",
        path: "/api/v1/emails",
      },
    } as any;

    await expect(getTeamFromToken(c)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
  });

  it("rejects an expired token", async () => {
    const token = await new jose.SignJWT({
      sub: "tpc-user-1",
      scope: "usesend:send",
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);

    const { getTeamFromToken } = await import("~/server/public-api/auth");

    const c = {
      req: {
        header: () => `Bearer ${token}`,
        method: "POST",
        path: "/api/v1/emails",
      },
    } as any;

    await expect(getTeamFromToken(c)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await new jose.SignJWT({
      sub: "tpc-user-1",
      scope: "usesend:send",
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience("https://someone-else.example.com")
      .setExpirationTime("5m")
      .sign(privateKey);

    const { getTeamFromToken } = await import("~/server/public-api/auth");

    const c = {
      req: {
        header: () => `Bearer ${token}`,
        method: "POST",
        path: "/api/v1/emails",
      },
    } as any;

    await expect(getTeamFromToken(c)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
  });

  it("returns 403 when the token's sub has no linked useSend user", async () => {
    const token = await signToken({ sub: "unknown-sub", scope: "usesend:send" });
    mockDb.user.findUnique.mockResolvedValue(null);

    const { getTeamFromToken } = await import("~/server/public-api/auth");

    const c = {
      req: {
        header: () => `Bearer ${token}`,
        method: "POST",
        path: "/api/v1/emails",
      },
    } as any;

    await expect(getTeamFromToken(c)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("still authenticates a valid opaque API key (regression)", async () => {
    mockGetTeamAndApiKey.mockResolvedValue({
      team: { id: 7, name: "Legacy" },
      apiKey: { id: 99, domainId: null },
    });

    const { getTeamFromToken } = await import("~/server/public-api/auth");

    const c = {
      req: {
        header: () => "Bearer us_client_token123",
        method: "POST",
        path: "/api/v1/emails",
      },
    } as any;

    const team = await getTeamFromToken(c);
    expect(team.id).toBe(7);
    expect(team.apiKeyId).toBe(99);
    expect(mockGetTeamAndApiKey).toHaveBeenCalledWith("us_client_token123");
  });
});
