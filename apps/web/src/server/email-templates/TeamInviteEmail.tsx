import { InviteEmail, renderEmail } from "@the-portland-company/ui-email";

interface TeamInviteEmailProps {
  inviterName?: string;
  teamName: string;
  role?: string;
  inviteUrl: string;
  logoUrl?: string;
}

export function TeamInviteEmail({ inviterName, teamName, role, inviteUrl }: TeamInviteEmailProps) {
  return InviteEmail({ inviterName, teamName, role, inviteUrl, siteName: "useSend" });
}

export async function renderTeamInviteEmail(props: TeamInviteEmailProps): Promise<string> {
  const { html } = await renderEmail(TeamInviteEmail(props));
  return html;
}
