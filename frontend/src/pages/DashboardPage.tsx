import { SystemStatus } from "../components/domain/SystemStatus";
import { EmailsTable } from "../components/domain/EmailsTable";
import { AppHeader } from "../components/layout/AppHeader";
import { Button } from "../components/ui/Button";
import { Card, CardHeader } from "../components/ui/Card";
import { useScheduledEmails, useSentEmails } from "../hooks/useEmails";
import { ApiError } from "../lib/apiClient";

export function DashboardPage() {
  const scheduled = useScheduledEmails();
  const sent = useSentEmails();

  return (
    <div className="min-h-full bg-surface-muted">
      <AppHeader />

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-ink">Dashboard</h1>
            <p className="mt-0.5 text-sm text-ink-muted">
              Schedule outbound email, then watch it move through the queue.
            </p>
          </div>
          <Button disabled title="Compose modal arrives in Phase 5 — schedule via POST /api/campaigns">
            Compose New Email
          </Button>
        </div>

        <SystemStatus />

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Scheduled Emails"
              description={
                scheduled.data
                  ? `${scheduled.data.meta.total} queued`
                  : "Queued and waiting to send"
              }
            />
            <EmailsTable
              rows={scheduled.data?.data}
              isLoading={scheduled.isPending}
              isError={scheduled.isError}
              errorMessage={
                scheduled.error instanceof ApiError ? scheduled.error.message : undefined
              }
              emptyTitle="No scheduled emails"
              emptyDescription="POST a campaign to /api/campaigns and rows will appear here within a few seconds."
              emptyIcon="scheduled"
              timeKind="scheduled"
            />
          </Card>

          <Card>
            <CardHeader
              title="Sent Emails"
              description={sent.data ? `${sent.data.meta.total} delivered or failed` : "Delivered or failed"}
            />
            <EmailsTable
              rows={sent.data?.data}
              isLoading={sent.isPending}
              isError={sent.isError}
              errorMessage={sent.error instanceof ApiError ? sent.error.message : undefined}
              emptyTitle="No sent emails"
              emptyDescription="Sent messages will show their Ethereal preview link here."
              emptyIcon="sent"
              timeKind="sent"
            />
          </Card>
        </div>
      </main>
    </div>
  );
}
