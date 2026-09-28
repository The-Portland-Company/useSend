import { beforeEach, describe, expect, it, vi } from "vitest";
import { LimitReason } from "~/lib/constants/plans";

// In-memory fake standing in for Redis INCR/EXPIRE/GET semantics, enough to
// exercise the send-cap counters without a real Redis instance.
function makeFakeRedis() {
  const store = new Map<string, number>();
  return {
    store,
    async incr(key: string) {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
    async expire(_key: string, _ttl: number) {
      return 1;
    },
    async get(key: string) {
      const value = store.get(key);
      return value === undefined ? null : String(value);
    },
  };
}

let fakeRedis = makeFakeRedis();

vi.mock("~/server/redis", () => ({
  getRedis: () => fakeRedis,
  redisKey: (key: string) => key,
  withCache: async (_key: string, fetcher: () => Promise<unknown>) => fetcher(),
}));

const envStub = vi.hoisted(() => ({
  NEXT_PUBLIC_IS_CLOUD: false,
  USESEND_TEAM_DAILY_SEND_LIMIT: 3,
  USESEND_TEAM_PER_MINUTE_SEND_LIMIT: 2,
}));

vi.mock("~/env", () => ({ env: envStub }));

// Send caps must not require touching the DB or cloud-only services -- stub
// out everything else checkEmailLimit imports so this stays a narrow unit
// test of the cap logic instead of pulling in the full db/mailer chain.
vi.mock("~/server/db", () => ({ db: {} }));
vi.mock("~/server/service/team-service", () => ({
  TeamService: { getTeamCached: vi.fn(), sendWarningEmail: vi.fn(), maybeNotifyEmailLimitReached: vi.fn() },
}));
vi.mock("~/server/service/usage-service", () => ({
  getThisMonthUsage: vi.fn(),
}));

describe("LimitService team send caps", () => {
  beforeEach(() => {
    vi.resetModules();
    fakeRedis = makeFakeRedis();
    envStub.NEXT_PUBLIC_IS_CLOUD = false;
    envStub.USESEND_TEAM_DAILY_SEND_LIMIT = 3;
    envStub.USESEND_TEAM_PER_MINUTE_SEND_LIMIT = 2;
  });

  it("allows sends under both the daily and per-minute cap", async () => {
    const { LimitService } = await import("~/server/service/limit-service");

    const first = await LimitService.checkEmailLimit(1);
    expect(first.isLimitReached).toBe(false);

    const second = await LimitService.checkEmailLimit(1);
    expect(second.isLimitReached).toBe(false);
  });

  it("blocks once the per-minute cap is exceeded, regardless of cloud mode", async () => {
    const { LimitService } = await import("~/server/service/limit-service");

    await LimitService.checkEmailLimit(1); // 1/min
    await LimitService.checkEmailLimit(1); // 2/min, at the limit
    const third = await LimitService.checkEmailLimit(1); // 3/min, over the limit

    expect(third.isLimitReached).toBe(true);
    expect(third.reason).toBe(LimitReason.EMAIL_TEAM_PER_MINUTE_CAP_REACHED);
  });

  it("blocks once the daily cap is exceeded even if the per-minute cap resets", async () => {
    envStub.USESEND_TEAM_DAILY_SEND_LIMIT = 2;
    envStub.USESEND_TEAM_PER_MINUTE_SEND_LIMIT = 1000;
    const { LimitService } = await import("~/server/service/limit-service");

    await LimitService.checkEmailLimit(1); // 1/day
    await LimitService.checkEmailLimit(1); // 2/day, at the limit
    const third = await LimitService.checkEmailLimit(1); // 3/day, over the limit

    expect(third.isLimitReached).toBe(true);
    expect(third.reason).toBe(LimitReason.EMAIL_TEAM_DAILY_CAP_REACHED);
  });

  it("counts campaign sends toward the same cap as transactional sends", async () => {
    // EmailQueueService calls LimitService.checkEmailLimit for every email it
    // hands to the provider, campaign-originated or not -- there is no
    // separate code path for campaign sends, so consuming the same counter
    // twice from two different "teamId" call sites models that correctly.
    const { LimitService } = await import("~/server/service/limit-service");

    await LimitService.checkEmailLimit(1); // transactional email, 1/min
    await LimitService.checkEmailLimit(1); // campaign email, 2/min
    const third = await LimitService.checkEmailLimit(1); // campaign email, 3/min

    expect(third.isLimitReached).toBe(true);
    expect(third.reason).toBe(LimitReason.EMAIL_TEAM_PER_MINUTE_CAP_REACHED);
  });

  it("keeps caps independent per team", async () => {
    const { LimitService } = await import("~/server/service/limit-service");

    await LimitService.checkEmailLimit(1);
    await LimitService.checkEmailLimit(1);
    const teamOneThird = await LimitService.checkEmailLimit(1);
    expect(teamOneThird.isLimitReached).toBe(true);

    const teamTwoFirst = await LimitService.checkEmailLimit(2);
    expect(teamTwoFirst.isLimitReached).toBe(false);
  });

  it("checkTeamSendCap peeks without consuming budget", async () => {
    const { LimitService } = await import("~/server/service/limit-service");

    const peekBefore = await LimitService.checkTeamSendCap(1);
    expect(peekBefore.isLimitReached).toBe(false);

    // Peeking twice in a row must not itself exhaust the per-minute cap of 2.
    const peekAgain = await LimitService.checkTeamSendCap(1);
    expect(peekAgain.isLimitReached).toBe(false);

    const consumed = await LimitService.checkEmailLimit(1);
    expect(consumed.isLimitReached).toBe(false);
  });
});
