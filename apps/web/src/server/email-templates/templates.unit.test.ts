import { describe, expect, it } from "vitest";
import { renderOtpEmail } from "./OtpEmail";
import { renderTeamInviteEmail } from "./TeamInviteEmail";
import { renderUsageWarningEmail } from "./UsageWarningEmail";
import { renderUsageLimitReachedEmail } from "./UsageLimitReachedEmail";
import { renderDomainVerificationStatusEmail } from "./DomainVerificationStatusEmail";
import { DomainStatus } from "@prisma/client";

describe("email-templates (TPC UI email package)", () => {
  it("renderOtpEmail includes the code and magic link", async () => {
    const html = await renderOtpEmail({
      otpCode: "ABC123",
      loginUrl: "https://app.usesend.com/login?token=abc123",
      hostName: "useSend",
    });
    expect(html).toContain("ABC123");
    expect(html).toContain("app.usesend.com/login");
    expect(html).toMatchSnapshot();
  });

  it("renderTeamInviteEmail includes team name and invite link", async () => {
    const html = await renderTeamInviteEmail({
      teamName: "My Awesome Team",
      inviteUrl: "https://app.usesend.com/join-team?inviteId=123",
    });
    expect(html).toContain("My Awesome Team");
    expect(html).toContain("join-team?inviteId=123");
    expect(html).toMatchSnapshot();
  });

  it("renderUsageWarningEmail includes usage figures", async () => {
    const html = await renderUsageWarningEmail({
      teamName: "Acme Inc",
      used: 8000,
      limit: 10000,
      isPaidPlan: false,
      period: "daily",
      manageUrl: "https://app.usesend.com/settings/billing",
    });
    expect(html).toContain("Acme Inc");
    expect(html).toContain("8,000");
    expect(html).toContain("10,000");
    expect(html).toMatchSnapshot();
  });

  it("renderUsageLimitReachedEmail includes the limit", async () => {
    const html = await renderUsageLimitReachedEmail({
      teamName: "Acme Inc",
      limit: 10000,
      isPaidPlan: true,
      period: "monthly",
      manageUrl: "https://app.usesend.com/settings/billing",
    });
    expect(html).toContain("Acme Inc");
    expect(html).toContain("10,000");
    expect(html).toMatchSnapshot();
  });

  it("renderDomainVerificationStatusEmail includes the domain name", async () => {
    const html = await renderDomainVerificationStatusEmail({
      domainName: "mail.example.com",
      currentStatus: DomainStatus.SUCCESS,
      previousStatus: DomainStatus.PENDING,
      domainUrl: "https://app.usesend.com/domains/1",
    });
    expect(html).toContain("mail.example.com");
    expect(html).toContain("verified");
    expect(html).toMatchSnapshot();
  });
});
