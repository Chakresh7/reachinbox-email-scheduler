import { Mail } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";

/**
 * Login page.
 *
 * The Google button points at the backend's OAuth entry route, which is a real
 * server-side redirect. It is disabled until Phase 4 implements that route, so
 * nothing here pretends to work — a mock login would be worse than a disabled
 * one.
 */
export function LoginPage() {
  return (
    <div className="flex min-h-full items-center justify-center bg-surface-muted px-4 py-12">
      <Card className="w-full max-w-md">
        <CardBody className="space-y-6 px-8 py-10 text-center">
          <div className="space-y-3">
            <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-brand text-ink-inverse">
              <Mail className="size-6" />
            </span>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold text-ink">ReachInbox Email Scheduler</h1>
              <p className="text-sm text-ink-muted">
                Sign in to schedule campaigns and monitor delivery.
              </p>
            </div>
          </div>

          <Button fullWidth size="lg" disabled title="Google OAuth arrives in Phase 4">
            Continue with Google
          </Button>

          <p className="text-xs text-ink-subtle">
            Google sign-in is wired in Phase 4. Until then the dashboard is reachable
            directly at <code className="font-mono">/dashboard</code>.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
