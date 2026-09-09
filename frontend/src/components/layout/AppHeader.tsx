import { Mail } from "lucide-react";
import { cn } from "../../lib/cn";
import type { AuthUser, SlackStatus } from "../../types/api";
import { Button } from "../ui/Button";

export interface AppHeaderProps {
  user?: AuthUser | null;
  onLogout?: () => void;
  slackConfigured?: boolean;
  slack?: SlackStatus | null;
  onSlackTest?: () => void;
  onSlackDisconnect?: () => void;
  slackTestPending?: boolean;
  className?: string;
}

/**
 * Top header: identity from Google session, plus Connect Slack / Connected chip.
 */
export function AppHeader({
  user,
  onLogout,
  slackConfigured = false,
  slack,
  onSlackTest,
  onSlackDisconnect,
  slackTestPending,
  className,
}: AppHeaderProps) {
  const connected = Boolean(slack?.connected);

  return (
    <header
      className={cn(
        "sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur",
        className,
      )}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand text-ink-inverse">
            <Mail className="size-4" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-ink">ReachInbox</p>
            <p className="text-xs text-ink-muted">Email Scheduler</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <a
            href="/admin/queues"
            target="_blank"
            rel="noreferrer"
            className="hidden text-xs font-medium text-ink-muted hover:text-ink sm:inline"
          >
            Queues
          </a>

          {user ? (
            slackConfigured ? (
              connected ? (
                <div className="flex items-center gap-2">
                  <span className="hidden rounded-full border border-line bg-surface-sunken px-2.5 py-1 text-xs font-medium text-ink sm:inline">
                    Slack · {slack?.channelName ?? slack?.teamName ?? "Connected"}
                  </span>
                  {onSlackTest ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onSlackTest}
                      loading={slackTestPending}
                    >
                      Test Slack
                    </Button>
                  ) : null}
                  {onSlackDisconnect ? (
                    <Button variant="ghost" size="sm" onClick={onSlackDisconnect}>
                      Disconnect
                    </Button>
                  ) : null}
                </div>
              ) : (
                <a
                  href="/api/slack/install"
                  className="inline-flex h-8 items-center rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-surface-sunken"
                >
                  Connect Slack
                </a>
              )
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled
                title="Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in backend/.env"
              >
                Connect Slack
              </Button>
            )
          ) : null}

          {user ? (
            <>
              <div className="hidden text-right leading-tight sm:block">
                <p className="text-sm font-medium text-ink">{user.name}</p>
                <p className="text-xs text-ink-muted">{user.email}</p>
              </div>
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.name}
                  className="size-9 rounded-full border border-line object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="flex size-9 items-center justify-center rounded-full bg-brand-subtle text-sm font-semibold text-brand">
                  {user.name.charAt(0).toUpperCase()}
                </span>
              )}
              {onLogout ? (
                <Button variant="secondary" size="sm" onClick={onLogout}>
                  Log out
                </Button>
              ) : null}
            </>
          ) : (
            <span className="text-xs text-ink-subtle">Not signed in</span>
          )}
        </div>
      </div>
    </header>
  );
}
