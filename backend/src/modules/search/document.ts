export interface EmailSearchDocument {
  id: string;
  campaignId: string;
  userId: string;
  senderId: string;
  senderEmail: string;
  recipientEmail: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  rescheduleCount: number;
  createdAt: string;
}

export interface EmailSearchHit {
  id: string;
  campaignId: string;
  recipientEmail: string;
  subject: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  senderEmail: string;
  rescheduleCount: number;
}

export function toSearchDocument(row: {
  id: string;
  campaignId: string;
  userId: string;
  senderId: string;
  recipientEmail: string;
  status: string;
  scheduledAt: Date;
  sentAt: Date | null;
  rescheduleCount: number;
  createdAt: Date;
  campaign: { subject: string; body: string };
  sender: { email: string };
}): EmailSearchDocument {
  return {
    id: row.id,
    campaignId: row.campaignId,
    userId: row.userId,
    senderId: row.senderId,
    senderEmail: row.sender.email,
    recipientEmail: row.recipientEmail,
    subject: row.campaign.subject,
    body: row.campaign.body,
    status: row.status,
    scheduledAt: row.scheduledAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    rescheduleCount: row.rescheduleCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export function documentToHit(doc: EmailSearchDocument): EmailSearchHit {
  return {
    id: doc.id,
    campaignId: doc.campaignId,
    recipientEmail: doc.recipientEmail,
    subject: doc.subject,
    status: doc.status,
    scheduledAt: doc.scheduledAt,
    sentAt: doc.sentAt,
    senderEmail: doc.senderEmail,
    rescheduleCount: doc.rescheduleCount,
  };
}
