import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import type { CreateCampaignResult, CsvPreview } from "../types/api";

export interface CreateCampaignInput {
  subject: string;
  body: string;
  startAt: Date;
  delayBetweenMs: number;
  hourlyLimit: number | null;
  file: File;
  idempotencyKey: string;
}

export function usePreviewCsv() {
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const res = await api.post<{ data: CsvPreview }>("/api/campaigns/preview-csv", form);
      return res.data;
    },
  });
}

export function useCreateCampaign() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateCampaignInput) => {
      const form = new FormData();
      form.append("subject", input.subject);
      form.append("body", input.body);
      form.append("startAt", input.startAt.toISOString());
      form.append("delayBetweenMs", String(input.delayBetweenMs));
      if (input.hourlyLimit !== null) {
        form.append("hourlyLimit", String(input.hourlyLimit));
      }
      form.append("file", input.file);
      const res = await api.post<{ data: CreateCampaignResult }>("/api/campaigns", form, {
        idempotencyKey: input.idempotencyKey,
      });
      return res.data;
    },
    onSuccess: (data) => {
      toast.success(`Scheduled ${data.validCount} recipient${data.validCount === 1 ? "" : "s"}`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.emails.all });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        toast.error(err.message);
        return;
      }
      toast.error("Could not schedule the campaign");
    },
  });
}
