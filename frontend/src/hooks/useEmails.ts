import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import type { EmailJobSummary, Paginated } from "../types/api";

export function useScheduledEmails() {
  return useQuery({
    queryKey: queryKeys.emails.scheduled({ page: 1 }),
    queryFn: () => api.get<Paginated<EmailJobSummary>>("/api/emails/scheduled", { query: { page: 1, limit: 25 } }),
    refetchInterval: 5_000,
  });
}

export function useSentEmails() {
  return useQuery({
    queryKey: queryKeys.emails.sent({ page: 1 }),
    queryFn: () => api.get<Paginated<EmailJobSummary>>("/api/emails/sent", { query: { page: 1, limit: 25 } }),
    refetchInterval: 5_000,
  });
}
