import { OtpEmail as TpcOtpEmail, renderEmail } from "@the-portland-company/ui-email";

interface OtpEmailProps {
  otpCode: string;
  loginUrl: string;
  hostName?: string;
  logoUrl?: string;
}

export function OtpEmail({ otpCode, loginUrl }: OtpEmailProps) {
  return TpcOtpEmail({ code: otpCode, magicLinkHref: loginUrl, siteName: "useSend" });
}

export async function renderOtpEmail(props: OtpEmailProps): Promise<string> {
  const { html } = await renderEmail(OtpEmail(props));
  return html;
}
