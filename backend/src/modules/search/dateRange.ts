const SENT_LIKE = new Set(["sent", "failed"]);

/** Date filter field: sentAt when every requested status is terminal, else scheduledAt. */
export function dateRangeField(statuses?: string[]): "sentAt" | "scheduledAt" {
  if (!statuses || statuses.length === 0) return "scheduledAt";
  return statuses.every((status) => SENT_LIKE.has(status)) ? "sentAt" : "scheduledAt";
}
