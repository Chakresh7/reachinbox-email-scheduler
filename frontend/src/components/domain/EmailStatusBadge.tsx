import type { BadgeTone } from "../ui/Badge";
import { Badge } from "../ui/Badge";
import type { EmailStatus } from "../../types/api";

const statusUi: Record<EmailStatus, { tone: BadgeTone; label: string }> = {
  scheduled: { tone: "scheduled", label: "Scheduled" },
  rate_limited: { tone: "ratelimited", label: "Rate limited" },
  claimed: { tone: "brand", label: "Sending" },
  sent: { tone: "sent", label: "Sent" },
  failed: { tone: "failed", label: "Failed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
  needs_review: { tone: "ratelimited", label: "Needs review" },
};

export function EmailStatusBadge({ status }: { status: EmailStatus }) {
  const ui = statusUi[status];
  return <Badge tone={ui.tone}>{ui.label}</Badge>;
}
