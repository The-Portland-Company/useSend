import {
  SESv2Client,
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  SendEmailCommand,
  CreateConfigurationSetEventDestinationCommand,
  CreateConfigurationSetCommand,
  EventType,
  GetAccountCommand,
  CreateTenantResourceAssociationCommand,
  DeleteTenantResourceAssociationCommand,
  DeleteSuppressedDestinationCommand,
} from "@aws-sdk/client-sesv2";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { generateKeyPairSync } from "crypto";
import nodemailer from "nodemailer";
import { env } from "~/env";
import { getAwsCredentialOptions } from "~/server/aws/credentials";
import { EmailContent } from "~/types";
import { logger } from "../logger/log";
import { buildHeaders } from "~/server/utils/email-headers";

let accountId: string | undefined = undefined;

async function getAccountId(region: string) {
  if (accountId) {
    return accountId;
  }

  const stsClient = new STSClient({
    region: region,
    ...getAwsCredentialOptions(),
  });
  const command = new GetCallerIdentityCommand({});
  const response = await stsClient.send(command);
  accountId = response.Account;
  return accountId;
}

async function getIdentityArn(domain: string, region: string) {
  const accountId = await getAccountId(region);
  return `arn:aws:ses:${region}:${accountId}:identity/${domain}`;
}

function getSesClient(region: string) {
  return new SESv2Client({
    region: region,
    endpoint: env.AWS_SES_ENDPOINT,
    ...getAwsCredentialOptions(),
  });
}

function generateKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 1024, // Length of your key in bits
    publicKeyEncoding: {
      type: "spki", // Recommended to be 'spki' by the Node.js docs
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8", // Recommended to be 'pkcs8' by the Node.js docs
      format: "pem",
    },
  });

  const base64PrivateKey = privateKey
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\n/g, "");

  const base64PublicKey = publicKey
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\n/g, "");

  return { privateKey: base64PrivateKey, publicKey: base64PublicKey };
}

export async function addDomain(
  domain: string,
  region: string,
  sesTenantId?: string,
  dkimSelector: string = "usesend"
) {
  const sesClient = getSesClient(region);

  const { privateKey, publicKey } = generateKeyPair();
  const command = new CreateEmailIdentityCommand({
    EmailIdentity: domain,
    DkimSigningAttributes: {
      DomainSigningSelector: dkimSelector,
      DomainSigningPrivateKey: privateKey,
    },
  });
  const response = await sesClient.send(command);

  const emailIdentityCommand = new PutEmailIdentityMailFromAttributesCommand({
    EmailIdentity: domain,
    MailFromDomain: `mail.${domain}`,
  });

  const emailIdentityResponse = await sesClient.send(emailIdentityCommand);

  if (sesTenantId) {
    const tenantResourceAssociationCommand =
      new CreateTenantResourceAssociationCommand({
        TenantName: sesTenantId,
        ResourceArn: await getIdentityArn(domain, region),
      });

    const tenantResourceAssociationResponse = await sesClient.send(
      tenantResourceAssociationCommand
    );

    if (tenantResourceAssociationResponse.$metadata.httpStatusCode !== 200) {
      logger.error(
        { tenantResourceAssociationResponse },
        "Failed to associate domain with tenant"
      );
      throw new Error("Failed to associate domain with tenant");
    }
  }

  if (
    response.$metadata.httpStatusCode !== 200 ||
    emailIdentityResponse.$metadata.httpStatusCode !== 200
  ) {
    logger.error(
      { response, emailIdentityResponse },
      "Failed to create domain identity"
    );
    throw new Error("Failed to create domain identity");
  }

  return publicKey;
}

export async function deleteDomain(
  domain: string,
  region: string,
  sesTenantId?: string
) {
  const sesClient = getSesClient(region);

  if (sesTenantId) {
    const tenantResourceAssociationCommand =
      new DeleteTenantResourceAssociationCommand({
        TenantName: sesTenantId,
        ResourceArn: await getIdentityArn(domain, region),
      });

    const tenantResourceAssociationResponse = await sesClient.send(
      tenantResourceAssociationCommand
    );

    if (tenantResourceAssociationResponse.$metadata.httpStatusCode !== 200) {
      logger.error(
        { tenantResourceAssociationResponse },
        "Failed to delete tenant resource association"
      );
      throw new Error("Failed to delete tenant resource association");
    }
  }

  const command = new DeleteEmailIdentityCommand({
    EmailIdentity: domain,
  });
  const response = await sesClient.send(command);
  return response.$metadata.httpStatusCode === 200;
}

export async function getDomainIdentity(domain: string, region: string) {
  const sesClient = getSesClient(region);
  const command = new GetEmailIdentityCommand({
    EmailIdentity: domain,
  });
  const response = await sesClient.send(command);
  return response;
}

/**
 * Sends an email through the Resend REST API. Used as a drop-in replacement for
 * the SES transport when RESEND_API_KEY is set. Returns a message id string so
 * callers (the queue worker) can treat it like an SES MessageId.
 */
async function sendRawEmailViaResend({
  to,
  from,
  subject,
  html,
  text,
  replyTo,
  cc,
  bcc,
  attachments,
  headers,
}: {
  to?: string[];
  from?: string;
  subject?: string;
  html?: string;
  text?: string;
  replyTo?: string[];
  cc?: string[];
  bcc?: string[];
  attachments?: { filename: string; content: string }[];
  headers?: Record<string, string>;
}): Promise<string> {
  const payload: Record<string, unknown> = {
    from,
    to,
    subject,
  };
  if (html) payload.html = html;
  if (text) payload.text = text;
  if (replyTo && replyTo.length) payload.reply_to = replyTo;
  if (cc && cc.length) payload.cc = cc;
  if (bcc && bcc.length) payload.bcc = bcc;
  if (headers && Object.keys(headers).length) payload.headers = headers;
  if (attachments && attachments.length) {
    payload.attachments = attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
    }));
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
  };

  if (!res.ok) {
    logger.error({ status: res.status, body }, "Resend send failed");
    throw new Error(`Resend send failed: ${body?.message || res.status}`);
  }

  logger.info({ messageId: body.id }, "Email sent via Resend!");
  return body.id ?? `resend_${Date.now()}`;
}

export async function sendRawEmail({
  to,
  from,
  subject,
  replyTo,
  cc,
  bcc,
  text,
  html,
  attachments,
  region,
  configurationSetName,
  unsubUrl,
  isBulk,
  inReplyToMessageId,
  emailId,
  sesTenantId,
  headers,
}: Partial<EmailContent> & {
  region: string;
  configurationSetName: string;
  attachments?: { filename: string; content: string }[]; // Made attachments optional
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  to?: string[];
  unsubUrl?: string;
  isBulk?: boolean;
  inReplyToMessageId?: string;
  emailId?: string;
}) {
  // When a Resend API key is configured, route ALL outbound mail through
  // Resend instead of SES. This makes the whole app (transactional sends,
  // campaigns, and double opt-in confirmations) work without an SES setup.
  if (process.env.RESEND_API_KEY) {
    return sendRawEmailViaResend({
      to,
      from,
      subject,
      html,
      text,
      replyTo,
      cc,
      bcc,
      attachments,
      headers: buildHeaders({
        emailId,
        headers,
        unsubUrl,
        isBulk,
        inReplyToMessageId,
      }),
    });
  }

  const sesClient = getSesClient(region);

  const { message: messageStream } = await nodemailer
    .createTransport({ streamTransport: true })
    .sendMail({
      from,
      to,
      subject,
      html,
      attachments: attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        encoding: "base64",
      })),
      text,
      replyTo,
      cc,
      bcc,
      headers: buildHeaders({
        emailId,
        headers,
        unsubUrl,
        isBulk,
        inReplyToMessageId,
      }),
    });

  const chunks = [];
  for await (const chunk of messageStream) {
    chunks.push(chunk);
  }
  const finalMessageData = Buffer.concat(chunks);

  const command = new SendEmailCommand({
    Content: {
      Raw: {
        Data: finalMessageData,
      },
    },
    ConfigurationSetName: configurationSetName,
    TenantName: sesTenantId ? sesTenantId : undefined,
  });

  try {
    const response = await sesClient.send(command);
    logger.info({ messageId: response.MessageId }, "Email sent!");
    return response.MessageId;
  } catch (error) {
    logger.error({ err: error }, "Failed to send email");
    // It's better to throw the original error or a new error with more context
    // throw new Error("Failed to send email");
    throw error;
  }
}

export async function getAccount(region: string) {
  const client = getSesClient(region);
  const input = new GetAccountCommand({});
  const response = await client.send(input);
  return response;
}

export async function addWebhookConfiguration(
  configName: string,
  topicArn: string,
  eventTypes: EventType[],
  region: string
) {
  const sesClient = getSesClient(region);

  const configSetCommand = new CreateConfigurationSetCommand({
    ConfigurationSetName: configName,
  });

  const configSetResponse = await sesClient.send(configSetCommand);

  if (configSetResponse.$metadata.httpStatusCode !== 200) {
    throw new Error("Failed to create configuration set");
  }

  const command = new CreateConfigurationSetEventDestinationCommand({
    ConfigurationSetName: configName, // required
    EventDestinationName: "usesend_destination", // required
    EventDestination: {
      Enabled: true,
      MatchingEventTypes: eventTypes,
      SnsDestination: {
        TopicArn: topicArn,
      },
    },
  });

  const response = await sesClient.send(command);
  return response.$metadata.httpStatusCode === 200;
}

/**
 * Remove email from AWS SES account-level suppression list
 * Returns true if successful or email wasn't suppressed, false on error
 */
export async function deleteFromSesSuppressionList(
  email: string,
  region: string
): Promise<boolean> {
  const sesClient = getSesClient(region);
  try {
    const command = new DeleteSuppressedDestinationCommand({
      EmailAddress: email,
    });
    await sesClient.send(command);
    logger.info({ email, region }, "Removed email from SES suppression list");
    return true;
  } catch (error: any) {
    // NotFoundException means email wasn't in SES suppression list - that's fine
    if (error.name === "NotFoundException") {
      logger.debug(
        { email, region },
        "Email not in SES suppression list (already removed or never added)"
      );
      return true;
    }
    logger.error(
      { email, region, error: error.message },
      "Failed to remove email from SES suppression list"
    );
    return false;
  }
}
