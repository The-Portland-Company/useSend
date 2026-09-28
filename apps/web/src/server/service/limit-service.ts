import { PLAN_LIMITS, LimitReason } from "~/lib/constants/plans";
import { env } from "~/env";
import { getThisMonthUsage } from "./usage-service";
import { TeamService } from "./team-service";
import { withCache, getRedis, redisKey } from "../redis";
import { db } from "../db";
import { logger } from "../logger/log";
import { Plan } from "@prisma/client";

function isLimitExceeded(current: number, limit: number): boolean {
  if (limit === -1) return false; // unlimited
  return current >= limit;
}

function getActivePlan(team: { plan: Plan; isActive: boolean }): Plan {
  return team.isActive ? team.plan : "FREE";
}

// UTC calendar day, e.g. "2026-09-28".
function dayBucket(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

// Whole-minute bucket since epoch, e.g. 29234123.
function minuteBucket(date: Date = new Date()): number {
  return Math.floor(date.getTime() / 60_000);
}

async function peekCount(key: string): Promise<number> {
  const redis = getRedis();
  const value = await redis.get(redisKey(key));
  return value ? parseInt(value, 10) : 0;
}

async function incrWithExpire(key: string, ttlSeconds: number): Promise<number> {
  const redis = getRedis();
  const prefixedKey = redisKey(key);
  const count = await redis.incr(prefixedKey);
  if (count === 1) {
    await redis.expire(prefixedKey, ttlSeconds);
  }
  return count;
}

type SendCapResult = {
  isLimitReached: boolean;
  reason?: LimitReason;
  limit?: number;
};

function sendCapKeys(teamId: number) {
  return {
    dayKey: `send-cap:day:${teamId}:${dayBucket()}`,
    minKey: `send-cap:min:${teamId}:${minuteBucket()}`,
  };
}

export class LimitService {
  static async checkDomainLimit(teamId: number): Promise<{
    isLimitReached: boolean;
    limit: number;
    reason?: LimitReason;
  }> {
    // Limits only apply in cloud mode
    if (!env.NEXT_PUBLIC_IS_CLOUD) {
      return { isLimitReached: false, limit: -1 };
    }

    const team = await TeamService.getTeamCached(teamId);
    const currentCount = await db.domain.count({ where: { teamId } });

    const limit = PLAN_LIMITS[getActivePlan(team)].domains;
    if (isLimitExceeded(currentCount, limit)) {
      return {
        isLimitReached: true,
        limit,
        reason: LimitReason.DOMAIN,
      };
    }

    return {
      isLimitReached: false,
      limit,
    };
  }

  static async checkContactBookLimit(teamId: number): Promise<{
    isLimitReached: boolean;
    limit: number;
    reason?: LimitReason;
  }> {
    // Limits only apply in cloud mode
    if (!env.NEXT_PUBLIC_IS_CLOUD) {
      return { isLimitReached: false, limit: -1 };
    }

    const team = await TeamService.getTeamCached(teamId);
    const currentCount = await db.contactBook.count({ where: { teamId } });

    const limit = PLAN_LIMITS[getActivePlan(team)].contactBooks;
    if (isLimitExceeded(currentCount, limit)) {
      return {
        isLimitReached: true,
        limit,
        reason: LimitReason.CONTACT_BOOK,
      };
    }

    return {
      isLimitReached: false,
      limit,
    };
  }

  static async checkTeamMemberLimit(teamId: number): Promise<{
    isLimitReached: boolean;
    limit: number;
    reason?: LimitReason;
  }> {
    // Limits only apply in cloud mode
    if (!env.NEXT_PUBLIC_IS_CLOUD) {
      return { isLimitReached: false, limit: -1 };
    }

    const team = await TeamService.getTeamCached(teamId);
    const currentCount = await db.teamUser.count({ where: { teamId } });

    const limit = PLAN_LIMITS[getActivePlan(team)].teamMembers;
    if (isLimitExceeded(currentCount, limit)) {
      return {
        isLimitReached: true,
        limit,
        reason: LimitReason.TEAM_MEMBER,
      };
    }

    return {
      isLimitReached: false,
      limit,
    };
  }

  static async checkWebhookLimit(teamId: number): Promise<{
    isLimitReached: boolean;
    limit: number;
    reason?: LimitReason;
  }> {
    // Limits only apply in cloud mode
    if (!env.NEXT_PUBLIC_IS_CLOUD) {
      return { isLimitReached: false, limit: -1 };
    }

    const team = await TeamService.getTeamCached(teamId);
    const currentCount = await db.webhook.count({
      where: { teamId },
    });

    const limit = PLAN_LIMITS[getActivePlan(team)].webhooks;
    if (isLimitExceeded(currentCount, limit)) {
      return {
        isLimitReached: true,
        limit,
        reason: LimitReason.WEBHOOK,
      };
    }

    return {
      isLimitReached: false,
      limit,
    };
  }

  /**
   * Read-only check of the hard per-team send caps (daily + per-minute).
   * Does not consume budget -- safe to call for an early/synchronous 429
   * before an email is queued. Enforced regardless of NEXT_PUBLIC_IS_CLOUD.
   */
  static async checkTeamSendCap(teamId: number): Promise<SendCapResult> {
    const dailyLimit = env.USESEND_TEAM_DAILY_SEND_LIMIT;
    const perMinuteLimit = env.USESEND_TEAM_PER_MINUTE_SEND_LIMIT;
    const { dayKey, minKey } = sendCapKeys(teamId);

    const [dayCount, minCount] = await Promise.all([
      peekCount(dayKey),
      peekCount(minKey),
    ]);

    if (dailyLimit >= 0 && dayCount >= dailyLimit) {
      return {
        isLimitReached: true,
        reason: LimitReason.EMAIL_TEAM_DAILY_CAP_REACHED,
        limit: dailyLimit,
      };
    }

    if (perMinuteLimit >= 0 && minCount >= perMinuteLimit) {
      return {
        isLimitReached: true,
        reason: LimitReason.EMAIL_TEAM_PER_MINUTE_CAP_REACHED,
        limit: perMinuteLimit,
      };
    }

    return { isLimitReached: false };
  }

  /**
   * Consumes one unit of the per-team send caps (daily + per-minute) and
   * reports whether that consumption exceeded either cap. Call this exactly
   * once per email, right before it is actually handed to the sending
   * provider (see EmailQueueService), so campaign sends and transactional
   * sends are counted the same way. Enforced regardless of NEXT_PUBLIC_IS_CLOUD.
   */
  static async consumeTeamSendCap(teamId: number): Promise<SendCapResult> {
    const dailyLimit = env.USESEND_TEAM_DAILY_SEND_LIMIT;
    const perMinuteLimit = env.USESEND_TEAM_PER_MINUTE_SEND_LIMIT;
    const { dayKey, minKey } = sendCapKeys(teamId);

    const [dayCount, minCount] = await Promise.all([
      incrWithExpire(dayKey, 60 * 60 * 26), // a bit over a day, covers clock skew
      incrWithExpire(minKey, 90), // a bit over a minute
    ]);

    if (dailyLimit >= 0 && dayCount > dailyLimit) {
      return {
        isLimitReached: true,
        reason: LimitReason.EMAIL_TEAM_DAILY_CAP_REACHED,
        limit: dailyLimit,
      };
    }

    if (perMinuteLimit >= 0 && minCount > perMinuteLimit) {
      return {
        isLimitReached: true,
        reason: LimitReason.EMAIL_TEAM_PER_MINUTE_CAP_REACHED,
        limit: perMinuteLimit,
      };
    }

    return { isLimitReached: false };
  }

  // Checks email sending limits and also triggers usage notifications.
  // Side effects:
  // - Sends "warning" emails when nearing daily/monthly limits (rate-limited in TeamService)
  // - Sends "limit reached" notifications when limits are exceeded (rate-limited in TeamService)
  // - Teams with inactive subscriptions are treated like FREE plans for monthly limit alerts
  static async checkEmailLimit(teamId: number): Promise<{
    isLimitReached: boolean;
    limit: number;
    reason?: LimitReason;
    available?: number;
  }> {
    // Hard per-team send caps apply regardless of cloud mode. Consumed here
    // (rather than just peeked) because this is the single choke point every
    // email -- transactional or campaign -- passes through right before send.
    const capCheck = await this.consumeTeamSendCap(teamId);
    if (capCheck.isLimitReached) {
      return {
        isLimitReached: true,
        limit: capCheck.limit ?? 0,
        reason: capCheck.reason,
      };
    }

    // Plan-based limits only apply in cloud mode
    if (!env.NEXT_PUBLIC_IS_CLOUD) {
      return { isLimitReached: false, limit: -1 };
    }

    const team = await TeamService.getTeamCached(teamId);

    // In cloud, enforce verification and block flags first
    if (team.isBlocked) {
      return {
        isLimitReached: true,
        limit: 0,
        reason: LimitReason.EMAIL_BLOCKED,
      };
    }

    // Enforce daily sending limit (team-specific)
    const usage = await withCache(
      `usage:this-month:${teamId}`,
      () => getThisMonthUsage(teamId),
      { ttlSeconds: 60 },
    );

    const dailyUsage = usage.day.reduce((acc, curr) => acc + curr.sent, 0);
    const activePlan = getActivePlan(team);
    const dailyLimit =
      activePlan !== "FREE"
        ? team.dailyEmailLimit
        : PLAN_LIMITS.FREE.emailsPerDay;

    logger.info(
      { dailyUsage, dailyLimit, team },
      `[LimitService]: Daily usage and limit`,
    );

    if (isLimitExceeded(dailyUsage, dailyLimit)) {
      // Notify: daily limit reached
      try {
        await TeamService.maybeNotifyEmailLimitReached(
          teamId,
          dailyLimit,
          LimitReason.EMAIL_DAILY_LIMIT_REACHED,
        );
      } catch (e) {
        logger.warn(
          { err: e },
          "Failed to send daily limit reached notification",
        );
      }

      return {
        isLimitReached: true,
        limit: dailyLimit,
        reason: LimitReason.EMAIL_DAILY_LIMIT_REACHED,
        available: dailyLimit - dailyUsage,
      };
    }

    // Apply monthly limit logic for FREE plan or inactive subscriptions
    if (getActivePlan(team) === "FREE") {
      const monthlyUsage = usage.month.reduce(
        (acc, curr) => acc + curr.sent,
        0,
      );
      // Use FREE plan limits for inactive subscriptions
      const monthlyLimit = PLAN_LIMITS.FREE.emailsPerMonth;

      logger.info(
        { monthlyUsage, monthlyLimit, team, isActive: team.isActive },
        `[LimitService]: Monthly usage and limit (FREE plan or inactive subscription)`,
      );

      if (monthlyUsage / monthlyLimit > 0.8 && monthlyUsage < monthlyLimit) {
        await TeamService.sendWarningEmail(
          teamId,
          monthlyUsage,
          monthlyLimit,
          LimitReason.EMAIL_FREE_PLAN_MONTHLY_LIMIT_REACHED,
        );
      }

      logger.info(
        { monthlyUsage, monthlyLimit, team, isActive: team.isActive },
        `[LimitService]: Monthly usage and limit (FREE plan or inactive subscription)`,
      );

      if (isLimitExceeded(monthlyUsage, monthlyLimit)) {
        // Notify: monthly (free plan or inactive subscription) limit reached
        try {
          await TeamService.maybeNotifyEmailLimitReached(
            teamId,
            monthlyLimit,
            LimitReason.EMAIL_FREE_PLAN_MONTHLY_LIMIT_REACHED,
          );
        } catch (e) {
          logger.warn(
            { err: e },
            "Failed to send monthly limit reached notification",
          );
        }

        return {
          isLimitReached: true,
          limit: monthlyLimit,
          reason: LimitReason.EMAIL_FREE_PLAN_MONTHLY_LIMIT_REACHED,
          available: monthlyLimit - monthlyUsage,
        };
      }
    }

    // Warn: nearing daily limit (e.g., < 20% available)
    if (
      dailyLimit !== -1 &&
      dailyLimit > 0 &&
      dailyLimit - dailyUsage > 0 &&
      (dailyLimit - dailyUsage) / dailyLimit < 0.2
    ) {
      try {
        await TeamService.sendWarningEmail(
          teamId,
          dailyUsage,
          dailyLimit,
          LimitReason.EMAIL_DAILY_LIMIT_REACHED,
        );
      } catch (e) {
        logger.warn({ err: e }, "Failed to send daily warning email");
      }
    }

    return {
      isLimitReached: false,
      limit: dailyLimit,
      available: dailyLimit - dailyUsage,
    };
  }
}
