/**
 * Elasticsearch mapping for the emails index (DESIGN.md §12).
 *
 * recipientEmail is keyword + text so exact address filters stay precise while
 * a prefix like `john` still matches john@acme.com. subject is text + keyword
 * for relevance and exact aggregations.
 */

export const EMAILS_PHYSICAL_INDEX_SUFFIX = "_v1";

export const emailsIndexSettings = {
  number_of_shards: 1,
  number_of_replicas: 0,
} as const;

export const emailsIndexMappings = {
  properties: {
    id: { type: "keyword" },
    campaignId: { type: "keyword" },
    userId: { type: "keyword" },
    senderId: { type: "keyword" },
    senderEmail: { type: "keyword" },
    recipientEmail: { type: "keyword", fields: { text: { type: "text" } } },
    subject: { type: "text", fields: { keyword: { type: "keyword" } } },
    body: { type: "text" },
    status: { type: "keyword" },
    scheduledAt: { type: "date" },
    sentAt: { type: "date" },
    rescheduleCount: { type: "integer" },
    createdAt: { type: "date" },
  },
} as const;
