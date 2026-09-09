import { CalendarClock, Inbox } from "lucide-react";
import { EmailStatusBadge } from "./EmailStatusBadge";
import { EmptyState } from "../ui/EmptyState";
import { Pagination } from "../ui/Pagination";
import { SkeletonRows } from "../ui/Skeleton";
import type { EmailJobSummary, PageMeta } from "../../types/api";

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function EmailsTable({
  rows,
  isLoading,
  isError,
  errorMessage,
  emptyTitle,
  emptyDescription,
  emptyIcon,
  timeKind,
  meta,
  onPageChange,
}: {
  rows: EmailJobSummary[] | undefined;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyIcon: "scheduled" | "sent";
  timeKind: "scheduled" | "sent";
  meta?: PageMeta;
  onPageChange?: (page: number) => void;
}) {
  if (isLoading) {
    return <SkeletonRows rows={5} columns={4} />;
  }

  if (isError) {
    return (
      <p className="px-5 py-8 text-sm text-status-failed">
        {errorMessage ?? "Could not load emails."}
      </p>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <EmptyState
        icon={emptyIcon === "scheduled" ? <CalendarClock className="size-5" /> : <Inbox className="size-5" />}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs text-ink-muted">
            <tr>
              <th className="px-5 py-2 font-medium">Email</th>
              <th className="px-5 py-2 font-medium">Subject</th>
              <th className="px-5 py-2 font-medium">{timeKind === "scheduled" ? "Scheduled" : "Sent"}</th>
              <th className="px-5 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={row.id} className="text-ink">
                <td className="px-5 py-3 font-mono text-xs">{row.recipientEmail}</td>
                <td className="max-w-[16rem] truncate px-5 py-3">{row.subject}</td>
                <td className="px-5 py-3 tabular text-ink-muted">
                  {formatWhen(timeKind === "scheduled" ? row.scheduledAt : row.sentAt)}
                </td>
                <td className="px-5 py-3">
                  <div className="flex flex-col gap-1">
                    <EmailStatusBadge status={row.status} />
                    {row.rescheduleCount > 0 ? (
                      <span className="text-xs text-ink-muted">Deferred {row.rescheduleCount}×</span>
                    ) : null}
                    {row.previewUrl ? (
                      <a
                        href={row.previewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-brand hover:underline"
                      >
                        Preview
                      </a>
                    ) : null}
                    {row.lastError ? (
                      <span className="max-w-[14rem] truncate text-xs text-status-failed" title={row.lastError}>
                        {row.lastError}
                      </span>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {meta && onPageChange ? (
        <Pagination
          page={meta.page}
          totalPages={meta.totalPages}
          total={meta.total}
          onPageChange={onPageChange}
        />
      ) : null}
    </div>
  );
}
