import type { Request } from "express";
import { env } from "../config/env";

function stripSlash(url: string): string {
  return url.replace(/\/$/, "");
}

/**
 * Public origin of the incoming request.
 *
 * Hosted (Render) sits behind a proxy, so X-Forwarded-Proto/Host win.
 * Local Vite proxies `/api` with `changeOrigin: true`, so Express sees
 * `localhost:4000` — the same host Google already has as a redirect URI.
 */
export function requestPublicOrigin(req: Request): string {
  const forwardedHost = req.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.get("host")?.trim();
  if (!host) {
    return stripSlash(env.API_PUBLIC_URL);
  }
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwardedProto || req.protocol || "http";
  return `${proto}://${host}`;
}

export function oauthCallbackUrl(req: Request, path: "/api/auth/google/callback" | "/api/slack/callback"): string {
  return `${requestPublicOrigin(req)}${path}`;
}
