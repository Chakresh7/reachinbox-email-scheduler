import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import type { AuthFeatures, AuthUser } from "../types/api";

export function useAuth() {
  return useQuery({
    queryKey: queryKeys.auth.me,
    queryFn: async () => {
      const res = await api.get<{ data: AuthUser }>("/api/auth/me");
      return res.data;
    },
    retry: false,
  });
}

export function useAuthFeatures() {
  return useQuery({
    queryKey: queryKeys.auth.features,
    queryFn: async () => {
      const res = await api.get<{ data: AuthFeatures }>("/api/auth/features");
      return res.data;
    },
    staleTime: 60_000,
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>("/api/auth/logout"),
    onSuccess: () => {
      queryClient.clear();
      window.location.assign("/login");
    },
  });
}
