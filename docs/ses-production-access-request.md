# SES production access request (account 270254975945, us-east-2)

Prior request DENIED — support case 178796436000064. `PutAccountDetails` now returns ConflictException, so the only path is replying on that case (Support Center, console) or opening a new SES sending-limit case.

## Use-case text (submit verbatim on the case)

WHO WE ARE: The Portland Company (Portland, OR) is a small web/marketing agency. We operate a self-hosted instance of useSend (open-source email platform, https://emailmarketing.theportlandcompany.com, hosted on Railway) to send email for our own brands, primarily NuEra Heat (nueraheat.net / nueraheat.com, a heating-products e-commerce store we own and operate).

HOW RECIPIENTS OPT IN: Every recipient is an existing NuEra Heat customer who purchased from our store or explicitly subscribed via the store's newsletter form. We do not buy, rent, scrape, or import third-party lists. New subscribers go through double opt-in before receiving marketing. The current list is ~4,000 contacts.

WHAT WE SEND: (1) Transactional: order/contact-form confirmations and login magic links. (2) Marketing: product announcements and occasional promotions, roughly 1-2 campaigns per month. Expected volume: under 10,000 emails/month, peak a few messages per second.

BOUNCE AND COMPLAINT HANDLING: SES feedback notifications (bounce, complaint, delivery) reach the useSend app via SNS -> HTTPS webhook and are processed automatically: hard-bounced and complained addresses are immediately suppressed in our database and never emailed again. Account-level suppression list is enabled for BOUNCE and COMPLAINT. We monitor bounce/complaint rates and keep them well under 5% / 0.1%.

UNSUBSCRIBE: Every marketing email contains a visible one-click unsubscribe link plus List-Unsubscribe / List-Unsubscribe-Post headers; opt-outs are honored immediately and permanently.

AUTHENTICATION: theportlandcompany.com is verified in SES with Easy DKIM (SUCCESS); SPF/DMARC published. All sending domains and content are our own.
