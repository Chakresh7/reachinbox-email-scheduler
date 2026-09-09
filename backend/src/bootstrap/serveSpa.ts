import { existsSync } from "node:fs";
import path from "node:path";
import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import { env } from "../config/env";
import { childLogger } from "../lib/logger";

const log = childLogger("spa");

function isApiPath(urlPath: string): boolean {
  return (
    urlPath.startsWith("/api") ||
    urlPath.startsWith("/admin") ||
    urlPath === "/healthz" ||
    urlPath === "/readyz"
  );
}

/**
 * Serve the Vite build from this process so production is one origin.
 *
 * The session cookie is SameSite=Lax. That only works when the browser talks
 * to the API on the same host as the dashboard — the same reason Vite proxies
 * `/api` in development. A separate frontend host would need a cross-site
 * cookie and break this design.
 *
 * No-op when `FRONTEND_DIST` is unset (local `npm run dev`, tests, worker).
 */
export function serveSpa(app: Express): void {
  const dist = env.FRONTEND_DIST;
  if (!dist) return;

  const indexHtml = path.resolve(dist, "index.html");
  if (!existsSync(indexHtml)) {
    log.warn({ dist }, "FRONTEND_DIST is set but index.html is missing; SPA not mounted");
    return;
  }

  app.use(
    express.static(dist, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith(`${path.sep}index.html`)) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          return;
        }
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (isApiPath(req.path)) {
      next();
      return;
    }
    if (path.extname(req.path)) {
      next();
      return;
    }
    res.sendFile(indexHtml, (err) => {
      if (err) next(err);
    });
  });

  log.info({ dist }, "serving dashboard from FRONTEND_DIST");
}
