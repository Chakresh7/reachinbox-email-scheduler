import { Link } from "react-router-dom";
import { Card, CardBody } from "../components/ui/Card";

export function NotFoundPage() {
  return (
    <div className="flex min-h-full items-center justify-center bg-surface-muted px-4 py-12">
      <Card className="w-full max-w-md">
        <CardBody className="space-y-3 px-8 py-10 text-center">
          <p className="text-3xl font-semibold text-ink">404</p>
          <p className="text-sm text-ink-muted">That page does not exist.</p>
          <Link to="/dashboard" className="inline-block text-sm font-medium text-brand hover:underline">
            Back to dashboard
          </Link>
        </CardBody>
      </Card>
    </div>
  );
}
