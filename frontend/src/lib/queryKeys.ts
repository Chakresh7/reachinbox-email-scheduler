/**
 * Centralised TanStack Query keys.
 *
 * Defined in one place so cache invalidation after scheduling a campaign is a
 * single call against a known prefix, rather than string literals scattered
 * across hooks that drift apart and cause stale tables.
 */
export const queryKeys = {
  readiness: ["readiness"] as const,

  auth: {
    me: ["auth", "me"] as const,
  },

  emails: {
    all: ["emails"] as const,
    scheduled: (params: Record<string, unknown> = {}) =>
      ["emails", "scheduled", params] as const,
    sent: (params: Record<string, unknown> = {}) => ["emails", "sent", params] as const,
    detail: (id: string) => ["emails", "detail", id] as const,
    stats: ["emails", "stats"] as const,
  },

  campaigns: {
    all: ["campaigns"] as const,
    list: (params: Record<string, unknown> = {}) => ["campaigns", "list", params] as const,
    detail: (id: string) => ["campaigns", "detail", id] as const,
  },

  senders: {
    all: ["senders"] as const,
  },

  slack: {
    status: ["slack", "status"] as const,
  },

  search: (params: Record<string, unknown>) => ["search", params] as const,
} as const;
