import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import type { ReadinessReport } from "../types/api";

/**
 * Live dependency health from the real backend.
 *
 * `/readyz` returns 503 when a critical dependency is down, which the API
 * client turns into a thrown ApiError — so a red Postgres surfaces as an error
 * state here rather than silently rendering as "fine".
 */
export function useReadiness() {
  return useQuery<ReadinessReport>({
    queryKey: queryKeys.readiness,
    queryFn: () => api.get<ReadinessReport>("/readyz"),
    refetchInterval: 15_000,
    // Health should reflect now, not a cached value from a minute ago.
    staleTime: 0,
    retry: false,
  });
}
