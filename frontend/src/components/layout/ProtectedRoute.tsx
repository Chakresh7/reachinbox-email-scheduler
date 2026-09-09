import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { Spinner } from "../ui/Spinner";
import { useAuth } from "../../hooks/useAuth";
import { ApiError } from "../../lib/apiClient";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const auth = useAuth();

  if (auth.isPending) {
    return (
      <div className="flex min-h-full items-center justify-center bg-surface-muted">
        <Spinner size="lg" label="Checking session" />
      </div>
    );
  }

  if (auth.error instanceof ApiError && auth.error.status === 401) {
    return <Navigate to="/login" replace />;
  }

  if (!auth.data) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
