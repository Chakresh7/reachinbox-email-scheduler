import { Navigate, createBrowserRouter } from "react-router-dom";
import { ProtectedRoute } from "./components/layout/ProtectedRoute";
import { Spinner } from "./components/ui/Spinner";
import { useAuth } from "./hooks/useAuth";
import { ApiError } from "./lib/apiClient";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";

function RootRedirect() {
  const auth = useAuth();
  if (auth.isPending) {
    return (
      <div className="flex min-h-full items-center justify-center bg-surface-muted">
        <Spinner size="lg" label="Checking session" />
      </div>
    );
  }
  if (auth.data) return <Navigate to="/dashboard" replace />;
  if (auth.error instanceof ApiError && auth.error.status === 401) {
    return <Navigate to="/login" replace />;
  }
  return <Navigate to="/login" replace />;
}

export const router = createBrowserRouter([
  { path: "/", element: <RootRedirect /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/auth/callback", element: <Navigate to="/dashboard" replace /> },
  {
    path: "/dashboard",
    element: (
      <ProtectedRoute>
        <DashboardPage />
      </ProtectedRoute>
    ),
  },
  { path: "*", element: <NotFoundPage /> },
]);
