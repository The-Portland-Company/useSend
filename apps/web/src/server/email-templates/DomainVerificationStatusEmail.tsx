import { DomainStatus } from "@prisma/client";
import { NotificationEmail, renderEmail } from "@the-portland-company/ui-email";

interface DomainVerificationStatusEmailProps {
  domainName: string;
  currentStatus: DomainStatus;
  previousStatus: DomainStatus;
  domainUrl: string;
}

function formatDomainStatus(status: DomainStatus) {
  return status.toLowerCase().replaceAll("_", " ");
}

function getTitle(currentStatus: DomainStatus, previousStatus: DomainStatus) {
  if (currentStatus === DomainStatus.SUCCESS) {
    return previousStatus === DomainStatus.SUCCESS
      ? "Domain verification checked"
      : "Your domain is verified";
  }

  if (previousStatus === DomainStatus.SUCCESS) {
    return "Your domain status changed";
  }

  return "Your domain verification needs attention";
}

export function DomainVerificationStatusEmail({
  domainName,
  currentStatus,
  previousStatus,
  domainUrl,
}: DomainVerificationStatusEmailProps) {
  const statusMessage =
    currentStatus === DomainStatus.SUCCESS
      ? `Your domain ${domainName} is now verified, and you can start sending emails.`
      : `Your domain ${domainName} could not be verified because the DNS records are not set up correctly yet. Please review your DNS settings and try again.`;

  return NotificationEmail({
    title: getTitle(currentStatus, previousStatus),
    body: `${statusMessage} Current status: ${formatDomainStatus(currentStatus)}.`,
    ctaHref: domainUrl,
    ctaLabel: "Open domain settings",
    siteName: "useSend",
  });
}

export async function renderDomainVerificationStatusEmail(
  props: DomainVerificationStatusEmailProps,
): Promise<string> {
  const { html } = await renderEmail(DomainVerificationStatusEmail(props));
  return html;
}
