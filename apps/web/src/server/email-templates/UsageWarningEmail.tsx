import { NotificationEmail, renderEmail } from "@the-portland-company/ui-email";

interface UsageWarningEmailProps {
  teamName: string;
  used: number;
  limit: number;
  isPaidPlan: boolean;
  period?: "daily" | "monthly";
  manageUrl?: string;
  logoUrl?: string;
}

export function UsageWarningEmail({
  teamName,
  used,
  limit,
  isPaidPlan,
  period = "daily",
  manageUrl = "#",
}: UsageWarningEmailProps) {
  const percent = limit > 0 ? Math.round((used / limit) * 100) : 80;
  return NotificationEmail({
    title: "You're nearing your email limit",
    body: `Hi ${teamName} team, you've used ${used.toLocaleString()} of your ${limit.toLocaleString()} ${period} emails — approximately ${percent}% of your limit. Consider ${
      isPaidPlan ? "verifying your team by replying to this email" : "upgrading your plan"
    }.`,
    ctaHref: manageUrl,
    ctaLabel: isPaidPlan ? "Verify team" : "Upgrade",
    siteName: "useSend",
  });
}

export async function renderUsageWarningEmail(props: UsageWarningEmailProps): Promise<string> {
  const { html } = await renderEmail(UsageWarningEmail(props));
  return html;
}
