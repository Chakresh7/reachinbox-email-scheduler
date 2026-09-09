import { Mail } from "lucide-react";
import { cn } from "../../lib/cn";
import type { AuthUser } from "../../types/api";
import { Button } from "../ui/Button";

export interface AppHeaderProps {
  user?: AuthUser | null;
  onLogout?: () => void;
  className?: string;
}

/**
 * Top header.
 *
 * The user's name, email and avatar are a stated requirement, so the shape is
 * fixed now; Phase 4 supplies the real user from Google OAuth and Phase 4 also
 * adds the Connect Slack control here.
 */
export function AppHeader({ user, onLogout, className }: AppHeaderProps) {
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

        {user ? (
          <div className="flex items-center gap-3">
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
          </div>
        ) : (
          <span className="text-xs text-ink-subtle">Not signed in</span>
        )}
      </div>
    </header>
  );
}
