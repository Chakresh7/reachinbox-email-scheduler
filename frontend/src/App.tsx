import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";
import { ApiError, onUnauthorized } from "./lib/apiClient";
import { router } from "./router";

/**
 * Query client defaults.
 *
 * The retry rule is the important part: retrying a 401 or a 400 is pointless
 * and only delays showing the user the real problem, whereas a transient 5xx or
 * a dropped connection is worth one more attempt.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});

export function App() {
  useEffect(
    // Session expiry is handled in one place. Phase 4 swaps this for a redirect
    // to /login once there is a login to redirect to.
    () =>
      onUnauthorized(() => {
        void queryClient.invalidateQueries({ queryKey: ["auth"] });
      }),
    [],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="top-right" richColors closeButton />
    </QueryClientProvider>
  );
}
