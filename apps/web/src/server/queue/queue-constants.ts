export const SES_WEBHOOK_QUEUE = "ses-webhook";
export const CAMPAIGN_MAIL_PROCESSING_QUEUE = "campaign-emails-processing";
export const CONTACT_BULK_ADD_QUEUE = "contact-bulk-add";
export const CAMPAIGN_BATCH_QUEUE = "campaign-batch";
export const CAMPAIGN_SCHEDULER_QUEUE = "campaign-scheduler";
export const DOMAIN_VERIFICATION_QUEUE = "domain-verification";
export const WEBHOOK_DISPATCH_QUEUE = "webhook-dispatch";
export const WEBHOOK_CLEANUP_QUEUE = "webhook-cleanup";

export const DEFAULT_QUEUE_OPTIONS = {
  // Retry transient SES failures (throttling / transient 5xx) instead of
  // dropping the email. executeEmail decides whether a given error is
  // retryable; only retryable errors are re-thrown so these attempts apply.
  attempts: 5,
  backoff: {
    type: "exponential" as const,
    delay: 2000,
  },
  removeOnComplete: true,
  removeOnFail: {
    age: 30 * 24 * 3600, // 30 days
  },
};
