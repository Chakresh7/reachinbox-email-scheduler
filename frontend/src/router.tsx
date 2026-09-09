import { Navigate, createBrowserRouter } from "react-router-dom";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";

/**
 * Routes.
 *
 * `/auth/callback` exists because the backend redirects the browser back to the
 * SPA after the Google exchange; Phase 4 fills it in. `ProtectedRoute` also
 * arrives in Phase 4 — gating routes now, before there is any way to log in,
 * would make the dashboard unreachable.
 */
export const router = createBrowserRouter([
  { path: "/", element: <Navigate to="/dashboard" replace /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/auth/callback", element: <Navigate to="/dashboard" replace /> },
  { path: "/dashboard", element: <DashboardPage /> },
  { path: "*", element: <NotFoundPage /> },
]);
