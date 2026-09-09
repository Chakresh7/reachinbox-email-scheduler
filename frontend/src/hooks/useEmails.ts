import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import type { EmailJobSummary, Paginated, SearchHit, SearchResponse } from "../types/api";

const PAGE_SIZE = 25;

export function useScheduledEmails(page: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.emails.scheduled({ page, limit: PAGE_SIZE }),
    queryFn: () =>
      api.get<Paginated<EmailJobSummary>>("/api/emails/scheduled", {
        query: { page, limit: PAGE_SIZE },
      }),
    refetchInterval: 5_000,
    enabled,
  });
}

export function useSentEmails(page: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.emails.sent({ page, limit: PAGE_SIZE }),
    queryFn: () =>
      api.get<Paginated<EmailJobSummary>>("/api/emails/sent", {
        query: { page, limit: PAGE_SIZE },
      }),
    refetchInterval: 5_000,
    enabled,
  });
}

const SCHEDULED_STATUSES = "scheduled,rate_limited,claimed";
const SENT_STATUSES = "sent,failed";

export function searchHitToSummary(hit: SearchHit): EmailJobSummary {
  return {
    ...hit,
    previewUrl: null,
    lastError: null,
  };
}

export function useEmailSearch(input: {
  q: string;
  tab: "scheduled" | "sent";
  page: number;
  enabled: boolean;
}) {
  const status = input.tab === "scheduled" ? SCHEDULED_STATUSES : SENT_STATUSES;
  return useQuery({
    queryKey: queryKeys.search({ q: input.q, status, page: input.page, limit: PAGE_SIZE }),
    queryFn: () =>
      api.get<SearchResponse>("/api/search", {
        query: { q: input.q, status, page: input.page, limit: PAGE_SIZE },
      }),
    refetchInterval: 5_000,
    enabled: input.enabled,
  });
}
