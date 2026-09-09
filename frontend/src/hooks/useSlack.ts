import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import type { SlackStatus } from "../types/api";

export function useSlackStatus() {
  return useQuery({
    queryKey: queryKeys.slack.status,
    queryFn: async () => {
      const res = await api.get<{ data: SlackStatus }>("/api/slack/status");
      return res.data;
    },
  });
}

export function useDisconnectSlack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>("/api/slack/disconnect"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.slack.status });
      toast.success("Slack disconnected");
    },
  });
}

export function useTestSlack() {
  return useMutation({
    mutationFn: () => api.post<{ data: { ok: boolean } }>("/api/slack/test"),
    onSuccess: () => {
      toast.success("Test message posted to Slack");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Slack test failed");
    },
  });
}
