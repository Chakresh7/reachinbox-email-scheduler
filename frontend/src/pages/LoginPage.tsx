import { Mail } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { useAuthFeatures } from "../hooks/useAuth";

export function LoginPage() {
  const features = useAuthFeatures();
  const googleReady = features.data?.google === true;

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
                Sign in with Google to schedule campaigns and monitor delivery.
              </p>
            </div>
          </div>

          {features.isPending ? (
            <div className="flex justify-center py-2">
              <Spinner label="Checking Google configuration" />
            </div>
          ) : googleReady ? (
            <a
              href="/api/auth/google"
              className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-brand text-base font-medium text-ink-inverse shadow-sm hover:bg-brand-hover"
            >
              Continue with Google
            </a>
          ) : (
            <Button
              fullWidth
              size="lg"
              disabled
              title="Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env"
            >
              Continue with Google
            </Button>
          )}

          <p className="text-xs text-ink-subtle">
            {googleReady
              ? "You will be redirected to Google, then back to the dashboard."
              : "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env, then restart the API."}
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
