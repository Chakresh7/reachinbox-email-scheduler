import { CalendarClock, Inbox } from "lucide-react";
import { SystemStatus } from "../components/domain/SystemStatus";
import { AppHeader } from "../components/layout/AppHeader";
import { Button } from "../components/ui/Button";
import { Card, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";

/**
 * Dashboard shell.
 *
 * Phase 0 renders the layout plus live infrastructure health. The Scheduled and
 * Sent tabs, the Compose modal and the search bar arrive in Phase 5, built on
 * the primitives in components/ui.
 */
export function DashboardPage() {
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
          <Button disabled title="Available in Phase 5">
            Compose New Email
          </Button>
        </div>

        <SystemStatus />

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Scheduled Emails"
              description="Queued and waiting to send"
            />
            <EmptyState
              icon={<CalendarClock className="size-5" />}
              title="No scheduled emails"
              description="Once the scheduling API lands in Phase 1, campaigns you schedule will appear here."
            />
          </Card>

          <Card>
            <CardHeader title="Sent Emails" description="Delivered or failed" />
            <EmptyState
              icon={<Inbox className="size-5" />}
              title="No sent emails"
              description="Sent messages will show their Ethereal preview link here."
            />
          </Card>
        </div>
      </main>
    </div>
  );
}
