import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ComposeEmailModal } from "../components/domain/ComposeEmailModal";
import { EmailsTable } from "../components/domain/EmailsTable";
import { SearchBar } from "../components/domain/SearchBar";
import { SystemStatus } from "../components/domain/SystemStatus";
import { AppHeader } from "../components/layout/AppHeader";
import { Button } from "../components/ui/Button";
import { Card, CardHeader } from "../components/ui/Card";
import { Tabs } from "../components/ui/Tabs";
import { useAuth, useAuthFeatures, useLogout } from "../hooks/useAuth";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import {
  searchHitToSummary,
  useEmailSearch,
  useScheduledEmails,
  useSentEmails,
} from "../hooks/useEmails";
import { useDisconnectSlack, useSlackStatus, useTestSlack } from "../hooks/useSlack";
import { ApiError } from "../lib/apiClient";
import type { EmailJobSummary, PageMeta } from "../types/api";

type InboxTab = "scheduled" | "sent";

export function DashboardPage() {
  const [composeOpen, setComposeOpen] = useState(false);
  const [tab, setTab] = useState<InboxTab>("scheduled");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const searching = debouncedQuery.trim().length > 0;

  const auth = useAuth();
  const features = useAuthFeatures();
  const slack = useSlackStatus();
  const logout = useLogout();
  const testSlack = useTestSlack();
  const disconnectSlack = useDisconnectSlack();
  const [params, setParams] = useSearchParams();

  const scheduled = useScheduledEmails(page, tab === "scheduled" && !searching);
  const sent = useSentEmails(page, tab === "sent" && !searching);
  const search = useEmailSearch({
    q: debouncedQuery.trim(),
    tab,
    page,
    enabled: searching,
  });

  useEffect(() => {
    setPage(1);
  }, [tab, debouncedQuery]);

  useEffect(() => {
    const slackParam = params.get("slack");
    if (slackParam === "connected") {
      toast.success("Slack connected");
      void slack.refetch();
      params.delete("slack");
      setParams(params, { replace: true });
    } else if (slackParam === "error") {
      toast.error("Slack authorization was cancelled or failed");
      params.delete("slack");
      setParams(params, { replace: true });
    }
  }, [params, setParams, slack]);

  const activeList = tab === "scheduled" ? scheduled : sent;
  let rows: EmailJobSummary[] | undefined;
  let meta: PageMeta | undefined;
  let isLoading = false;
  let isError = false;
  let errorMessage: string | undefined;
  let degraded = false;

  if (searching) {
    isLoading = search.isLoading;
    isError = search.isError;
    errorMessage = search.error instanceof ApiError ? search.error.message : undefined;
    rows = search.data?.data.map(searchHitToSummary);
    meta = search.data?.meta;
    degraded = search.data?.meta.degraded === true;
  } else {
    isLoading = activeList.isLoading;
    isError = activeList.isError;
    errorMessage = activeList.error instanceof ApiError ? activeList.error.message : undefined;
    rows = activeList.data?.data;
    meta = activeList.data?.meta;
  }

  return (
    <div className="min-h-full bg-surface-muted">
      <AppHeader
        user={auth.data}
        onLogout={() => logout.mutate()}
        slackConfigured={features.data?.slack === true}
        slack={slack.data}
        onSlackTest={() => testSlack.mutate()}
        onSlackDisconnect={() => disconnectSlack.mutate()}
        slackTestPending={testSlack.isPending}
      />

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-ink">Dashboard</h1>
            <p className="mt-0.5 text-sm text-ink-muted">
              Schedule outbound email, then watch it move through the queue.
            </p>
          </div>
          <Button onClick={() => setComposeOpen(true)}>Compose New Email</Button>
        </div>

        <SystemStatus />

        <Card>
          <CardHeader
            title={tab === "scheduled" ? "Scheduled Emails" : "Sent Emails"}
            description={
              meta
                ? `${meta.total} ${tab === "scheduled" ? "queued" : "delivered or failed"}`
                : tab === "scheduled"
                  ? "Queued and waiting to send"
                  : "Delivered or failed"
            }
            actions={
              <div className="w-56 sm:w-72">
                <SearchBar value={query} onChange={setQuery} />
              </div>
            }
          />
          <div className="px-5 pt-4">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: "scheduled", label: "Scheduled" },
                { id: "sent", label: "Sent" },
              ]}
            />
            {degraded ? (
              <p className="mt-3 text-xs text-ink-muted">
                Search is using Postgres fallback while Elasticsearch is unavailable.
              </p>
            ) : null}
          </div>
          <EmailsTable
            rows={rows}
            isLoading={isLoading}
            isError={isError}
            errorMessage={errorMessage}
            emptyTitle={
              searching
                ? "No matching emails"
                : tab === "scheduled"
                  ? "No scheduled emails"
                  : "No sent emails"
            }
            emptyDescription={
              searching
                ? "Try a different subject or recipient."
                : tab === "scheduled"
                  ? "Compose a campaign to schedule email."
                  : "Sent messages will show their Ethereal preview link here."
            }
            emptyIcon={tab === "scheduled" ? "scheduled" : "sent"}
            timeKind={tab === "scheduled" ? "scheduled" : "sent"}
            meta={meta}
            onPageChange={setPage}
          />
        </Card>
      </main>

      <ComposeEmailModal open={composeOpen} onClose={() => setComposeOpen(false)} />
    </div>
  );
}
