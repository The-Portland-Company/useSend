import { NotificationEmail, renderEmail } from "@the-portland-company/ui-email";

interface UsageLimitReachedEmailProps {
  teamName: string;
  limit: number;
  isPaidPlan: boolean;
  period?: "daily" | "monthly";
  manageUrl?: string;
  logoUrl?: string;
}

export function UsageLimitReachedEmail({
  teamName,
  limit,
  isPaidPlan,
  period = "daily",
  manageUrl = "#",
}: UsageLimitReachedEmailProps) {
  return NotificationEmail({
    title: "You've reached your email limit",
    body: `Hi ${teamName} team, you've reached your ${period} limit of ${limit.toLocaleString()} emails. Sending is temporarily paused until your limit resets or ${
      isPaidPlan ? "your team is verified" : "your plan is upgraded"
    }.`,
    ctaHref: manageUrl,
    ctaLabel: "Manage plan",
    siteName: "useSend",
  });
}

export async function renderUsageLimitReachedEmail(props: UsageLimitReachedEmailProps): Promise<string> {
  const { html } = await renderEmail(UsageLimitReachedEmail(props));
  return html;
}
