export interface CampaignExpandJobData {
  campaignId: string;
  batchIndex: number;
}

export interface EmailSendJobData {
  emailJobId: string;
}

export type SearchIndexJobData =
  | { emailJobId: string }
  | { emailJobIds: string[]; campaignId: string; batchIndex: number };

export interface NotificationJobData {
  type: "RATE_LIMIT_HIT";
  userId: string;
  senderId: string;
  hourWindowIso: string;
  limitValue: number;
  jobsDeferred: number;
}
