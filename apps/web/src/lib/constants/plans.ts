import { Plan } from "@prisma/client";

export enum LimitReason {
  DOMAIN = "DOMAIN",
  CONTACT_BOOK = "CONTACT_BOOK",
  TEAM_MEMBER = "TEAM_MEMBER",
  WEBHOOK = "WEBHOOK",
  EMAIL_BLOCKED = "EMAIL_BLOCKED",
  EMAIL_DAILY_LIMIT_REACHED = "EMAIL_DAILY_LIMIT_REACHED",
  EMAIL_FREE_PLAN_MONTHLY_LIMIT_REACHED = "EMAIL_FREE_PLAN_MONTHLY_LIMIT_REACHED",
  // Hard per-team send caps enforced regardless of cloud mode (self-hosted included).
  EMAIL_TEAM_DAILY_CAP_REACHED = "EMAIL_TEAM_DAILY_CAP_REACHED",
  EMAIL_TEAM_PER_MINUTE_CAP_REACHED = "EMAIL_TEAM_PER_MINUTE_CAP_REACHED",
}

export const PLAN_LIMITS: Record<
  Plan,
  {
    emailsPerMonth: number;
    emailsPerDay: number;
    domains: number;
    contactBooks: number;
    teamMembers: number;
    webhooks: number;
  }
> = {
  FREE: {
    emailsPerMonth: 3000,
    emailsPerDay: 100,
    domains: 1,
    contactBooks: 1,
    teamMembers: 1,
    webhooks: 1,
  },
  BASIC: {
    emailsPerMonth: -1, // unlimited
    emailsPerDay: -1, // unlimited
    domains: -1,
    contactBooks: -1,
    teamMembers: -1,
    webhooks: -1,
  },
};
