import { AlertTriangle, CheckCircle2, CircleSlash, RefreshCw, XCircle } from "lucide-react";
import { ApiError } from "../../lib/apiClient";
import { cn } from "../../lib/cn";
import { useReadiness } from "../../hooks/useReadiness";
import type { DependencyReport, DependencyState } from "../../types/api";
import { Badge, type BadgeTone } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, CardBody, CardHeader } from "../ui/Card";
import { SkeletonRows } from "../ui/Skeleton";

/**
 * Live infrastructure health.
 *
 * This is the Phase 0 vertical slice: the browser calls the real API, which
 * pings the real Postgres, Redis and Elasticsearch. Nothing here is mocked, so
 * a green row is genuine proof the whole path works end to end.
 *
 * It also surfaces the Redis `maxmemory-policy`, which is the one silent
 * misconfiguration that would lose scheduled emails without any error.
 */

const stateConfig: Record<
  DependencyState,
  { tone: BadgeTone; label: string; icon: React.ReactNode }
> = {
  ok: { tone: "sent", label: "Healthy", icon: <CheckCircle2 className="size-3.5" /> },
  degraded: {
    tone: "ratelimited",
    label: "Degraded",
    icon: <AlertTriangle className="size-3.5" />,
  },
  down: { tone: "failed", label: "Down", icon: <XCircle className="size-3.5" /> },
  not_configured: {
    tone: "neutral",
    label: "Not configured",
    icon: <CircleSlash className="size-3.5" />,
  },
};

const dependencyLabels = {
  postgres: "PostgreSQL",
  redis: "Redis",
  elasticsearch: "Elasticsearch",
} as const;

function formatDetail(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function DependencyRow({ name, report }: { name: string; report: DependencyReport }) {
  const config = stateConfig[report.status];
  const detailEntries = Object.entries(report.detail ?? {});

  return (
    <li className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{name}</span>
          {report.critical ? null : (
            <span className="text-xs text-ink-subtle">(non-critical)</span>
          )}
        </div>

        {report.error ? (
          <p className="mt-1 text-xs break-words text-status-failed">{report.error}</p>
        ) : null}

        {detailEntries.length > 0 ? (
          <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
            {detailEntries.map(([key, value]) => (
              <div key={key} className="flex gap-1 text-xs text-ink-muted">
                <dt>{key}:</dt>
                <dd className="font-mono">{formatDetail(value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {report.latencyMs !== undefined ? (
          <span className="tabular text-xs text-ink-muted">{report.latencyMs} ms</span>
        ) : null}
        <Badge tone={config.tone} icon={config.icon}>
          {config.label}
        </Badge>
      </div>
    </li>
  );
}

export function SystemStatus() {
  const { data, isPending, isFetching, error, refetch } = useReadiness();

  const overallBadge = (() => {
    if (error) return { tone: "failed" as BadgeTone, label: "Unavailable" };
    if (!data) return { tone: "neutral" as BadgeTone, label: "Checking" };
    if (data.status === "ok") return { tone: "sent" as BadgeTone, label: "All systems go" };
    if (data.status === "degraded") return { tone: "ratelimited" as BadgeTone, label: "Degraded" };
    return { tone: "failed" as BadgeTone, label: "Unavailable" };
  })();

  return (
    <Card>
      <CardHeader
        title="Infrastructure"
        description={
          data
            ? `${data.environment} · v${data.version} · up ${data.uptimeSeconds}s`
            : "Live dependency health from the API"
        }
        actions={
          <>
            <Badge tone={overallBadge.tone}>{overallBadge.label}</Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refetch()}
              loading={isFetching && !isPending}
              aria-label="Refresh health"
              leftIcon={<RefreshCw className="size-3.5" />}
            >
              Refresh
            </Button>
          </>
        }
      />

      <CardBody>
        {isPending ? (
          <SkeletonRows rows={3} columns={2} className="divide-y-0" />
        ) : error ? (
          <div className="space-y-2 py-2">
            <p className="text-sm font-medium text-status-failed">
              {error instanceof ApiError && error.code === "NETWORK"
                ? "Cannot reach the API."
                : "The API reported a critical dependency failure."}
            </p>
            <p className="text-sm text-ink-muted">
              {error instanceof ApiError
                ? error.message
                : "An unexpected error occurred while checking health."}
            </p>
            <p className="text-xs text-ink-subtle">
              Start it with{" "}
              <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono">
                npm run dev
              </code>{" "}
              in <code className="font-mono">backend/</code>, and check that{" "}
              <code className="font-mono">backend/.env</code> is filled in.
            </p>
          </div>
        ) : (
          <ul className={cn("divide-y divide-line")}>
            {(
              Object.entries(data.dependencies) as [
                keyof typeof dependencyLabels,
                DependencyReport,
              ][]
            ).map(([key, report]) => (
              <DependencyRow key={key} name={dependencyLabels[key]} report={report} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
